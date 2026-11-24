import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ClockBoundary } from './boundaries.js'
import { EncoderSink, type SpoolSink } from './frame-sink.js'
import { createFfmpegArguments } from './screencast-arguments.js'
import {
  type ScreencastEncoderDependencies,
  spawnFfmpegEncoder,
} from './screencast-encoder.js'

// A replay reads the spool in pieces of this size, so one slow encoder never
// holds a whole spool in memory.
const REPLAY_CHUNK_BYTES = 1024 * 1024

/**
 * How a spooling segment becomes a live one, supplied by the layer that owns
 * the files: where the segment's output is planned, how it is reserved, and
 * how what promotion created is removed.
 */
export interface PromotionPlan {
  readonly ffmpegPath: string
  /** The segment's planned file; reserved only if promotion starts. */
  readonly plannedPath: string
  /** Removes a file this promotion reserved or the spool it replaced. */
  remove(filePath: string, description: string): Promise<void>
  /** Reserves the planned file and resolves the path actually reserved. */
  reserveOutput(plannedPath: string): Promise<string>
  /** Reports, once, that promotion failed and the segment keeps spooling. */
  warn(message: string): void
}

export interface SpoolPromotionDependencies
  extends ScreencastEncoderDependencies {
  readonly clock?: ClockBoundary
  readonly spawnProcess?: (command: string, args: string[]) => ChildProcess
}

/**
 * `spooling` is where promotion has not started; the machine then runs
 * `replaying`, and ends `live` (the recorder writes to the encoder),
 * `cancelled` (a stop or abort arrived first; the spool is kept) or `failed`
 * (the encoder could not take over; the spool is kept, with no second try).
 */
export type PromotionState =
  | 'spooling'
  | 'replaying'
  | 'live'
  | 'failed'
  | 'cancelled'

/**
 * Replays a spool into a new encoder while the recorder keeps appending to
 * it, then hands the recorder the encoder in one synchronous step: when every
 * byte flushed to disk has been replayed and nothing is buffered, nothing is
 * between the two, so FFmpeg receives one continuous stream.
 */
export class SpoolPromotion {
  private readonly spool: SpoolSink
  private readonly plan: PromotionPlan
  private readonly dependencies: SpoolPromotionDependencies
  private readonly switchTo: (encoder: EncoderSink) => void
  private readonly cancelSignal = Promise.withResolvers<void>()
  private currentState: PromotionState = 'spooling'
  private reservedPath: string | undefined
  private finished: Promise<void> | undefined

  constructor(
    spool: SpoolSink,
    plan: PromotionPlan,
    switchTo: (encoder: EncoderSink) => void,
    dependencies: SpoolPromotionDependencies = {},
  ) {
    this.spool = spool
    this.plan = plan
    this.switchTo = switchTo
    this.dependencies = dependencies
  }

  get state(): PromotionState {
    return this.currentState
  }

  /** The file the live encoder writes, once promotion has reserved it. */
  get outputPath(): string | undefined {
    return this.currentState === 'live' ? this.reservedPath : undefined
  }

  // A getter, so a state set while this awaited is read afresh.
  private get hasSwitched(): boolean {
    return this.currentState === 'live'
  }

  /** Begins the replay. Does nothing once promotion has begun. */
  start(): void {
    if (this.currentState !== 'spooling') {
      return
    }
    this.currentState = 'replaying'
    this.finished = this.run()
  }

  /**
   * Cancels a promotion that has not switched: no further byte is replayed and
   * no switch can follow, from this call on, and none will start. Resolves once the encoder has been aborted and what
   * promotion created removed, or, after the switch, once the spool is gone.
   */
  async cancel(): Promise<void> {
    if (this.currentState === 'spooling' || this.currentState === 'replaying') {
      this.currentState = 'cancelled'
      this.cancelSignal.resolve()
    }
    await this.finished
  }

  private async run(): Promise<void> {
    let encoder: EncoderSink | undefined
    try {
      encoder = await this.replayIntoEncoder()
    } catch (error) {
      await this.giveUp(error, undefined)
      return
    }
    if (this.hasSwitched && encoder) {
      await this.disposeSpool()
      return
    }
    await this.giveUp(undefined, encoder)
  }

  // Resolves the encoder once it has taken over, or while cancelled the one
  // that was started (to be aborted); throws if it cannot.
  private async replayIntoEncoder(): Promise<EncoderSink | undefined> {
    const output = await this.plan.reserveOutput(this.plan.plannedPath)
    this.reservedPath = output
    if (this.currentState !== 'replaying') {
      return undefined
    }
    const { canvas, crop, format, quality, scale } = this.spool.spool.settings
    // FFmpeg reads a name that starts with `-` as an option, and one with a
    // colon as a protocol. An absolute path is neither.
    const args = createFfmpegArguments(
      { format, outputPath: path.resolve(output), quality, scale },
      canvas,
      crop,
    )
    const spawnProcess = this.dependencies.spawnProcess ?? spawnFfmpegEncoder
    const encoder = new EncoderSink(
      spawnProcess(this.plan.ffmpegPath, args),
      this.dependencies,
      true,
    )
    try {
      await this.until(encoder.ready, encoder)
      encoder.markStarted()
      const file = await fs.open(this.spool.spool.path, 'r')
      try {
        await this.replay(file, encoder)
      } finally {
        await file.close().catch(() => undefined)
      }
    } catch (error) {
      await encoder.abort()
      throw error
    }
    if (!this.hasSwitched) {
      await encoder.abort()
    }
    return encoder
  }

  private async replay(file: fs.FileHandle, encoder: EncoderSink) {
    const { spool } = this
    let offset = 0
    while (this.currentState === 'replaying') {
      this.throwIfEncoderFailed(encoder)
      const flushed = spool.bytesWritten
      if (offset < flushed) {
        const chunk = Buffer.allocUnsafe(
          Math.min(REPLAY_CHUNK_BYTES, flushed - offset),
        )
        const { bytesRead } = await file.read(chunk, 0, chunk.length, offset)
        if (bytesRead === 0) {
          throw new Error('The frame spool could not be read back.')
        }
        offset += bytesRead
        if (
          this.currentState === 'replaying' &&
          !encoder.write(chunk.subarray(0, bytesRead))
        ) {
          await this.until(encoder.waitForDrain(), encoder)
        }
      } else if (spool.failure !== undefined) {
        throw new Error(spool.failure)
      } else if (spool.isClosed) {
        throw new Error('The frame spool closed during the replay.')
      } else if (spool.bytesBuffered === 0) {
        // Everything on disk is with FFmpeg and nothing is waiting to reach
        // the disk. No await separates this check from the switch.
        this.currentState = 'live'
        this.switchTo(encoder)
      } else {
        await this.until(spool.waitForFlush(), encoder)
      }
    }
  }

  // Waits for `task`, ending early if the promotion is cancelled or the
  // encoder fails first.
  private async until(task: Promise<void>, encoder: EncoderSink) {
    await Promise.race([
      task,
      this.cancelSignal.promise,
      encoder.failed.then((error) => {
        throw error
      }),
    ])
    this.throwIfEncoderFailed(encoder)
  }

  private throwIfEncoderFailed(encoder: EncoderSink): void {
    if (this.currentState === 'replaying' && encoder.failure !== undefined) {
      throw new Error(encoder.failure)
    }
  }

  // The encoder never took over: its output goes, and the spool stays.
  private async giveUp(
    error: unknown,
    encoder: EncoderSink | undefined,
  ): Promise<void> {
    await encoder?.abort()
    const cancelled = this.currentState === 'cancelled'
    if (!cancelled) {
      this.currentState = 'failed'
    }
    const output = this.reservedPath
    this.reservedPath = undefined
    if (output !== undefined) {
      await this.plan.remove(output, 'unused promoted recording output')
    }
    if (!cancelled) {
      this.plan.warn(
        `[WdioPuppeteerVideoService] Could not continue the recording of ${this.plan.plannedPath} as live encoding: ${describeFailure(error)} The frames keep going to the frame spool and are encoded when the recording ends.`,
      )
    }
  }

  // The encoder has everything the spool had. Close the spool and delete it,
  // but only if this recording's own exclusive open created it.
  private async disposeSpool(): Promise<void> {
    await this.spool.end()
    if (this.spool.created) {
      await this.plan.remove(
        this.spool.spool.path,
        'frame spool of a promoted recording',
      )
    }
  }
}

const describeFailure = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return message.endsWith('.') ? message : `${message}.`
}
