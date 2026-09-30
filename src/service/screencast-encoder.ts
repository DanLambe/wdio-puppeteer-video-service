import type { ChildProcess } from 'node:child_process'
import { type ClockBoundary, systemClock } from './boundaries.js'
import { FFMPEG_TERMINATION_HELPER_TIMEOUT_MS } from './constants.js'
import {
  type TerminateFfmpegProcessTree,
  terminateFfmpegProcessTree,
} from './process-supervisor.js'
import { Utf8TailBuffer } from './utf8-tail-buffer.js'

export interface FfmpegResult {
  readonly code: number | null
  readonly diagnostic: string
  readonly signal: NodeJS.Signals | null
}

export interface ScreencastEncoderDependencies {
  readonly clock?: ClockBoundary
  readonly terminateProcessTree?: TerminateFfmpegProcessTree
}

// Own the process from spawn, including the interval before CDP attaches.
export class ScreencastEncoder {
  private readonly child: ChildProcess
  private readonly spawnedState = Promise.withResolvers<void>()
  private readonly closedState = Promise.withResolvers<void>()
  private readonly failedState = Promise.withResolvers<Error>()
  private readonly stderr = new Utf8TailBuffer(4_000)
  private finishedDiagnostic: string | undefined
  private exitFailure: Error | undefined
  private failure: Error | undefined
  private didClose = false
  private starting: boolean
  private aborting: Promise<void> | undefined
  private readonly clock: ClockBoundary
  private readonly terminate: TerminateFfmpegProcessTree
  readonly closed: Promise<void> = this.closedState.promise
  readonly failed: Promise<Error> = this.failedState.promise
  readonly spawned: Promise<void> = this.spawnedState.promise

  constructor(
    child: ChildProcess,
    dependencies: ScreencastEncoderDependencies = {},
    starting = false,
  ) {
    this.child = child
    this.starting = starting
    this.clock = dependencies.clock ?? systemClock
    this.terminate =
      dependencies.terminateProcessTree ?? terminateFfmpegProcessTree
    child.once('spawn', this.onSpawn)
    child.on('error', this.onError)
    child.once('exit', this.onExit)
    child.once('close', this.onClose)
    child.stdin?.on('error', ignoreStreamError)
    child.stdin?.once('close', removeLateErrorGuard)
    child.stderr?.on('data', this.onDiagnostic)
  }

  get result(): FfmpegResult {
    return {
      code: this.child.exitCode,
      diagnostic: (this.finishedDiagnostic ?? this.stderr.peek()).trim(),
      signal: this.child.signalCode,
    }
  }

  abort(): Promise<void> {
    this.aborting ??= this.terminateOwnedProcess()
    return this.aborting
  }

  markStarted(): void {
    this.starting = false
  }

  throwIfFailed(): void {
    if (this.failure) {
      throw this.failure
    }
  }

  private readonly onDiagnostic = (chunk: Buffer): void => {
    this.stderr.append(chunk)
  }

  private readonly onSpawn = (): void => {
    this.spawnedState.resolve()
  }

  private readonly onError = (error: Error): void => {
    this.failure ??= error
    this.failedState.resolve(this.failure)
  }

  private readonly onExit = (): void => {
    const { code, signal, diagnostic } = this.result
    this.exitFailure ??= new Error()
    this.exitFailure.message = `FFmpeg ${signal ? `was terminated by ${signal}` : `exited with code ${String(code)}`} during screencast startup${diagnostic ? `: ${diagnostic}` : '.'}`
    this.onError(this.exitFailure)
  }

  private readonly onClose = (): void => {
    this.didClose = true
    this.finishedDiagnostic ??= this.stderr.finish()
    this.onExit()
    this.closedState.resolve()
    this.child.off('error', this.onError)
    this.child.off('spawn', this.onSpawn)
    this.child.off('exit', this.onExit)
    this.child.stderr?.off('data', this.onDiagnostic)
    this.child.stdin?.off('error', ignoreStreamError)
  }

  private async terminateOwnedProcess(): Promise<void> {
    this.child.stdin?.destroy()
    try {
      if (
        this.starting ||
        (this.child.exitCode === null && this.child.signalCode === null)
      ) {
        await this.terminate(this.child, true)
      }
      // Exit can precede the final stderr chunks and close. Drain that tail
      // within the existing cleanup budget, even if the process already exited.
      if (!this.didClose) {
        const expired = Promise.withResolvers<void>()
        const timer = this.clock.setTimeout(
          expired.resolve,
          FFMPEG_TERMINATION_HELPER_TIMEOUT_MS,
        )
        timer.unref?.()
        try {
          await Promise.race([this.closed, expired.promise])
        } finally {
          this.clock.clearTimeout(timer)
        }
      }
    } finally {
      this.child.off('spawn', this.onSpawn)
      this.child.off('exit', this.onExit)
      this.child.off('close', this.onClose)
      this.child.off('error', this.onError)
      this.child.stderr?.off('data', this.onDiagnostic)
      if (!this.didClose) {
        // A missing close must not retain the recorder through its listeners.
        // Keep only stateless guards for delayed errors from the killed child.
        this.child.on('error', ignoreStreamError)
        this.child.once('close', removeLateErrorGuard)
      }
      this.child.stdout?.destroy()
      this.child.stderr?.destroy()
      this.child.unref?.()
    }
  }
}

const ignoreStreamError = (): void => {}

function removeLateErrorGuard(this: NodeJS.EventEmitter): void {
  this.off('error', ignoreStreamError)
}
