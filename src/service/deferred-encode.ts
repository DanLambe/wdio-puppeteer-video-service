import fs from 'node:fs/promises'
import path from 'node:path'
import type { ResolvedConcurrencyOptions } from '../types.js'
import {
  ARTIFACT_PATH_CANDIDATE_LIMIT,
  getCollisionPath,
  reserveArtifactPath,
} from './artifact-integrity.js'
import type { ClockBoundary, FileSystemBoundary } from './boundaries.js'
import type { SegmentTab, SpooledSegment } from './capture-session.js'
import type { ActiveSegment, OutputFormat } from './constants.js'
import type { FfmpegRunResult } from './ffmpeg-runner.js'
import type { FfmpegRuntime } from './ffmpeg-runtime.js'
import { removeFileWithRetry } from './file-removal.js'
import type { ScreencastSpool } from './frame-sink.js'
import type { ServiceLogger } from './logging.js'
import { describeError } from './normalization.js'
import { encodeSpool, type SpoolEncodeRunner } from './spool-encode.js'

/** The limits of a recording's end-of-recording encode step. */
export interface DeferredEncodeLimits {
  /** The smallest budget a recording's spool encodes share. */
  readonly minimumBudgetMs: number
  /** Budget added per second the recording captured. */
  readonly budgetMsPerCapturedSecond: number
  /** The largest budget, however long the recording. */
  readonly maximumBudgetMs: number
  /** The longest one encode waits for a post-processing slot. */
  readonly maximumSlotWaitMs: number
}

export const DEFERRED_ENCODE_LIMITS: DeferredEncodeLimits = Object.freeze({
  minimumBudgetMs: 30_000,
  budgetMsPerCapturedSecond: 2_000,
  maximumBudgetMs: 300_000,
  maximumSlotWaitMs: 30_000,
})

/**
 * One budget per recording, shared by every slot wait, encode and retry of
 * its spools: `min(max(30 s, 2 × captured seconds), 5 min)` by default.
 */
export const resolveDeferredEncodeBudgetMs = (
  capturedSeconds: number,
  limits: DeferredEncodeLimits = DEFERRED_ENCODE_LIMITS,
): number =>
  Math.min(
    Math.max(
      limits.minimumBudgetMs,
      capturedSeconds * limits.budgetMsPerCapturedSecond,
    ),
    limits.maximumBudgetMs,
  )

/** What became of one spooled segment. */
export type DeferredEncodeOutcome =
  /** Encoded and checked; its spool is deleted. `segment` names the file. */
  | { readonly kind: 'encoded'; readonly segment: ActiveSegment }
  /**
   * Not encoded whole: its frames are kept, and `failure` says where and why.
   * Output FFmpeg did write is `partial`, kept as unclean media.
   */
  | {
      readonly kind: 'kept'
      readonly failure: string
      readonly partial?: ActiveSegment
    }

export interface DeferredEncodeResult {
  readonly held: SpooledSegment
  readonly outcome: DeferredEncodeOutcome
}

/** A spool whose segment is not being encoded, and what it was planned as. */
export interface UnencodedSpool {
  readonly part: number
  /** The segment's planned, unreserved file: its name and directory. */
  readonly plannedPath: string
  readonly spool: ScreencastSpool
  readonly tab?: SegmentTab
}

type DeferredEncodeFfmpeg = Pick<
  FfmpegRuntime,
  'isAcceptingWork' | 'resolvePath' | 'run' | 'withPostProcessSlot'
>

export interface DeferredEncoderOptions {
  readonly clock: ClockBoundary
  readonly concurrency: Pick<
    ResolvedConcurrencyOptions,
    'postProcessStartMode' | 'postProcessStartTimeoutMs'
  >
  readonly ffmpeg: DeferredEncodeFfmpeg
  readonly fileSystem: Pick<FileSystemBoundary, 'stat' | 'unlink'>
  readonly limits?: DeferredEncodeLimits
  /** Creates a second name for a file; fails with `EEXIST` if it is taken. */
  readonly linkFile?: (existingPath: string, newPath: string) => Promise<void>
  readonly log: ServiceLogger
  readonly reserveOutput?: (desiredPath: string) => Promise<string>
}

interface EncodeStep {
  readonly budgetMs: number
  readonly deadline: number
  readonly signal: AbortSignal
}

type Attempt =
  | { readonly ok: true; readonly outputPath: string }
  | {
      readonly ok: false
      readonly failure: string
      /** Bytes FFmpeg left at the reserved output, if one was reserved. */
      readonly outputBytes: number
      readonly outputPath: string | undefined
      readonly retryable: boolean
    }

const SPOOL_ENCODE_OPERATION = 'spool encode'
const FRAMES_EXTENSION = '.frames.mkv'
const MAX_ATTEMPTS = 2

/**
 * The end-of-recording encode of a kept recording's spools: admission,
 * deadlines, one retry, and keeping the frames of a segment that cannot be
 * encoded. Owns nothing but the spools it is given.
 */
export class DeferredEncoder {
  private readonly clock: ClockBoundary
  private readonly concurrency: DeferredEncoderOptions['concurrency']
  private readonly ffmpeg: DeferredEncodeFfmpeg
  private readonly fileSystem: DeferredEncoderOptions['fileSystem']
  private readonly limits: DeferredEncodeLimits
  private readonly linkFile: NonNullable<DeferredEncoderOptions['linkFile']>
  private readonly log: ServiceLogger
  private readonly reserveOutput: NonNullable<
    DeferredEncoderOptions['reserveOutput']
  >

  constructor(options: DeferredEncoderOptions) {
    this.clock = options.clock
    this.concurrency = options.concurrency
    this.ffmpeg = options.ffmpeg
    this.fileSystem = options.fileSystem
    this.limits = options.limits ?? DEFERRED_ENCODE_LIMITS
    this.linkFile = options.linkFile ?? fs.link
    this.log = options.log
    this.reserveOutput = options.reserveOutput ?? reserveArtifactPath
  }

  /**
   * Encodes each spooled segment, in the order given, within one budget for
   * them all. Once the budget runs out, the encode in flight is stopped and
   * every spool not yet encoded keeps its frames; nothing new starts.
   */
  async encodeAll(
    segments: readonly SpooledSegment[],
    capturedSeconds: number,
  ): Promise<DeferredEncodeResult[]> {
    const budgetMs = resolveDeferredEncodeBudgetMs(capturedSeconds, this.limits)
    const budget = new AbortController()
    const timer = this.clock.setTimeout(() => {
      budget.abort()
    }, budgetMs)
    timer.unref?.()
    const step: EncodeStep = {
      budgetMs,
      deadline: this.clock.now() + budgetMs,
      signal: budget.signal,
    }
    const results: DeferredEncodeResult[] = []
    try {
      for (const held of segments) {
        results.push({ held, outcome: await this.encodeSegment(held, step) })
      }
    } finally {
      this.clock.clearTimeout(timer)
    }
    return results
  }

  /**
   * Moves a spool that will not be encoded to `<name>.frames.mkv` beside its
   * planned segment, never replacing a file, and says where its frames are.
   * A spool that cannot be moved stays where it is, and the text names it.
   */
  async preserveFrames(spool: UnencodedSpool): Promise<string> {
    const moved = await this.moveToFramesFile(spool)
    const framesPath = moved.framesPath ?? spool.spool.path
    const where = moved.framesPath
      ? `Its frames are kept at ${framesPath}`
      : `Its frames could not be moved (${describeError(moved.error)}) and stay at ${framesPath}`
    return `${where}; convert them with: ${describeConversion(framesPath, spool.plannedPath)}`
  }

  private async encodeSegment(
    held: SpooledSegment,
    step: EncodeStep,
  ): Promise<DeferredEncodeOutcome> {
    let last: Extract<Attempt, { ok: false }> | undefined
    let outputPath: string | undefined
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const stopped = this.describeStoppedStep(step)
      if (stopped) {
        last = {
          failure: stopped,
          ok: false,
          outputBytes: last?.outputBytes ?? 0,
          outputPath,
          retryable: false,
        }
        break
      }
      const result = await this.attempt(held, step, outputPath)
      if (result.ok) {
        return this.completeEncoded(held, result.outputPath)
      }
      last = result
      outputPath = result.outputPath
      if (!result.retryable) {
        break
      }
      this.log(
        'debug',
        `[WdioPuppeteerVideoService] Retrying the encode of segment ${held.part.toString()}: ${result.failure}`,
      )
    }
    return this.keepFrames(held, last)
  }

  private async attempt(
    held: SpooledSegment,
    step: EncodeStep,
    reservedPath: string | undefined,
  ): Promise<Attempt> {
    let outputPath = reservedPath
    if (outputPath === undefined) {
      try {
        // Reserved now, not at capture start, so a discarded recording never
        // leaves a placeholder behind.
        outputPath = await this.reserveOutput(held.segment.recordingPath)
      } catch (error) {
        return {
          failure: `its output could not be reserved: ${describeError(error)}`,
          ok: false,
          outputBytes: 0,
          outputPath: undefined,
          retryable: true,
        }
      }
    }
    let run: FfmpegRunResult | undefined
    const runner: SpoolEncodeRunner = async (process) => {
      await this.ffmpeg.run(process.args, process.operation, {
        onResult: (result) => {
          run = result
        },
        signal: step.signal,
      })
      if (run?.kind === 'exited') {
        return {
          code: run.code,
          diagnostic: run.diagnostic,
          signal: run.signal,
        }
      }
      throw new Error(this.describeUnfinishedRun(run, step))
    }
    const target = outputPath
    const encoded = await this.ffmpeg.withPostProcessSlot(
      SPOOL_ENCODE_OPERATION,
      async () =>
        encodeSpool(
          {
            ffmpegPath: this.ffmpeg.resolvePath(),
            outputPath: target,
            spool: held.spool,
          },
          runner,
        ),
      { signal: step.signal, waitMs: this.slotWaitMs(step) },
    )
    const outputBytes = await this.sizeOf(target)
    if (encoded === undefined) {
      return {
        failure:
          this.describeStoppedStep(step) ??
          'no post-processing capacity was available in time',
        ok: false,
        outputBytes,
        outputPath: target,
        retryable: false,
      }
    }
    if (encoded.ok && outputBytes > 0 && held.clean) {
      return { ok: true, outputPath: target }
    }
    return {
      failure: describeFailedEncode(encoded, outputBytes, held),
      ok: false,
      outputBytes,
      outputPath: target,
      // Retrying cannot help a capture that was already incomplete, output
      // that can still be used, or a run that was stopped on purpose.
      retryable:
        held.clean &&
        outputBytes === 0 &&
        (run?.kind === 'exited' || run?.kind === 'spawn-failed'),
    }
  }

  private async completeEncoded(
    held: SpooledSegment,
    recordingPath: string,
  ): Promise<DeferredEncodeOutcome> {
    await removeFileWithRetry(
      { clock: this.clock, fileSystem: this.fileSystem, log: this.log },
      held.spool.path,
      'encoded frame spool',
    )
    return {
      kind: 'encoded',
      segment: withRecordingPath(held.segment, recordingPath),
    }
  }

  private async keepFrames(
    held: SpooledSegment,
    failed: Extract<Attempt, { ok: false }> | undefined,
  ): Promise<DeferredEncodeOutcome> {
    const outputPath = failed?.outputPath
    let partial: ActiveSegment | undefined
    if (outputPath !== undefined && (failed?.outputBytes ?? 0) > 0) {
      // Whatever FFmpeg wrote is kept, unprocessed, as a live encoder's is.
      partial = {
        ...held.segment,
        outputFormat: held.segment.recordingFormat,
        outputPath,
        recordingPath: outputPath,
        transcode: false,
      }
    } else if (outputPath !== undefined) {
      // The empty file that reserved the path is this worker's own.
      await removeFileWithRetry(
        { clock: this.clock, fileSystem: this.fileSystem, log: this.log },
        outputPath,
        'empty segment file',
      )
    }
    const tab = held.tab ? ` (tab ${held.tab.ordinal.toString()})` : ''
    const frames = await this.preserveFrames({
      part: held.part,
      plannedPath: held.segment.recordingPath,
      spool: held.spool,
      ...(held.tab ? { tab: held.tab } : {}),
    })
    const failure = `Segment ${held.part.toString()}${tab} could not be encoded: ${failed?.failure ?? 'the encode did not run'}. ${frames}`
    return { failure, kind: 'kept', ...(partial ? { partial } : {}) }
  }

  private async moveToFramesFile(
    spool: UnencodedSpool,
  ): Promise<{ framesPath?: string; error?: unknown }> {
    for (
      let collisionIndex = 1;
      collisionIndex <= ARTIFACT_PATH_CANDIDATE_LIMIT;
      collisionIndex += 1
    ) {
      const candidate = getCollisionPath(spool.plannedPath, collisionIndex)
      const parsed = path.parse(candidate)
      const framesPath = path.join(
        parsed.dir,
        `${parsed.name}${FRAMES_EXTENSION}`,
      )
      try {
        // A second name in the same directory tree: nothing is copied, and an
        // existing file is never replaced.
        await this.linkFile(spool.spool.path, framesPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          continue
        }
        return { error }
      }
      await removeFileWithRetry(
        { clock: this.clock, fileSystem: this.fileSystem, log: this.log },
        spool.spool.path,
        'moved frame spool',
      )
      return { framesPath }
    }
    return {
      error: new Error(
        `every candidate name for ${spool.plannedPath} is taken`,
      ),
    }
  }

  /** Why no more work may start, once the budget is spent or work stopped. */
  private describeStoppedStep(step: EncodeStep): string | undefined {
    if (step.signal.aborted) {
      return `the deferred-encode budget of ${formatSeconds(step.budgetMs)} ran out`
    }
    if (!this.ffmpeg.isAcceptingWork) {
      return 'the encode was cancelled at shutdown'
    }
    return undefined
  }

  private describeUnfinishedRun(
    run: FfmpegRunResult | undefined,
    step: EncodeStep,
  ): string {
    if (run?.kind === 'spawn-failed') {
      return run.message
    }
    if (run?.kind === 'stopped' && run.reason === 'timeout') {
      return 'the encode reached processing.ffmpeg.timeoutMs'
    }
    return (
      this.describeStoppedStep(step) ?? 'the encode was cancelled at shutdown'
    )
  }

  // At most the per-wait limit, never past the budget, and no longer than a
  // fast-fail start would wait for any other post-processing.
  private slotWaitMs(step: EncodeStep): number {
    const limits = [
      this.limits.maximumSlotWaitMs,
      Math.max(0, step.deadline - this.clock.now()),
    ]
    if (this.concurrency.postProcessStartMode === 'fast-fail') {
      limits.push(this.concurrency.postProcessStartTimeoutMs)
    }
    return Math.min(...limits)
  }

  private async sizeOf(filePath: string): Promise<number> {
    try {
      return (await this.fileSystem.stat(filePath)).size ?? 0
    } catch {
      return 0
    }
  }
}

const describeFailedEncode = (
  encoded: Awaited<ReturnType<typeof encodeSpool>>,
  outputBytes: number,
  held: SpooledSegment,
): string => {
  if (!encoded.ok) {
    return encoded.reason
  }
  if (outputBytes === 0) {
    return 'FFmpeg wrote an empty file'
  }
  return `its capture was incomplete (${held.incompleteReason ?? 'no frames arrived'})`
}

const withRecordingPath = (
  segment: ActiveSegment,
  recordingPath: string,
): ActiveSegment => ({
  ...segment,
  outputPath: segment.transcode
    ? replaceFileExtension(recordingPath, segment.outputFormat)
    : recordingPath,
  recordingPath,
})

const replaceFileExtension = (
  filePath: string,
  format: OutputFormat,
): string => {
  const parsed = path.parse(filePath)
  return path.join(parsed.dir, `${parsed.name}.${format}`)
}

const describeConversion = (
  framesPath: string,
  plannedPath: string,
): string => {
  const parsed = path.parse(plannedPath)
  const target = path.join(parsed.dir, `${parsed.name}.converted.webm`)
  return `ffmpeg -i "${framesPath}" -pix_fmt yuv420p "${target}"`
}

const formatSeconds = (milliseconds: number): string =>
  `${(milliseconds / 1_000).toString()}s`
