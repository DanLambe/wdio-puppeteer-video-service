import { type ChildProcess, spawn } from 'node:child_process'
import { type ClockBoundary, systemClock } from './boundaries.js'
import {
  FFMPEG_TERMINATION_GRACE_MS,
  FFMPEG_TERMINATION_HELPER_TIMEOUT_MS,
} from './constants.js'
import type { ServiceLogger } from './logging.js'
import {
  type FfmpegProcess,
  type TerminateFfmpegProcessTree,
  terminateFfmpegProcessTree,
} from './process-supervisor.js'
import { Utf8TailBuffer } from './utf8-tail-buffer.js'

export type SpawnFfmpegProcess = (
  ffmpegPath: string,
  args: string[],
) => FfmpegProcess

/** How one FFmpeg run ended, for a caller that needs more than success. */
export type FfmpegRunResult =
  | {
      readonly kind: 'exited'
      readonly code: number | null
      /** The end of FFmpeg's error output. */
      readonly diagnostic: string
      readonly signal: NodeJS.Signals | null
    }
  | { readonly kind: 'spawn-failed'; readonly message: string }
  | {
      readonly kind: 'stopped'
      /** Its own timeout, or a cancellation: `signal`, or every process stopped at shutdown. */
      readonly reason: 'cancelled' | 'timeout'
    }

export interface RunFfmpegOptions {
  args: string[]
  available: boolean
  ffmpegPath: string
  log: ServiceLogger
  markUnavailable: () => void
  operation: string
  /** Called once with how the run ended, whether or not it succeeded. */
  onResult?: (result: FfmpegRunResult) => void
  onStderr?: (output: string) => void
  /** Cancels the run: checked before the spawn, and stops a running process. */
  signal?: AbortSignal
  timeoutMs: number
  warnMissing: (reason: string) => void
}

export interface FfmpegRunnerDependencies {
  clock?: ClockBoundary
  processRegistry?: FfmpegProcessRegistry
  spawnProcess?: SpawnFfmpegProcess
  terminateProcessTree?: TerminateFfmpegProcessTree
}

interface RegisteredFfmpegProcess {
  terminate: () => Promise<void>
}

export class FfmpegProcessRegistry {
  private readonly activeProcesses = new Set<RegisteredFfmpegProcess>()

  get size(): number {
    return this.activeProcesses.size
  }

  register(process: RegisteredFfmpegProcess): () => void {
    this.activeProcesses.add(process)
    return () => {
      this.activeProcesses.delete(process)
    }
  }

  async terminateAll(): Promise<void> {
    await Promise.allSettled(
      [...this.activeProcesses].map((process) => process.terminate()),
    )
  }
}

export const spawnFfmpegProcess: SpawnFfmpegProcess = (
  ffmpegPath,
  args,
): ChildProcess => {
  return spawn(ffmpegPath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
}

export const runFfmpeg = async (
  options: RunFfmpegOptions,
  dependencies: FfmpegRunnerDependencies = {},
): Promise<boolean> => {
  if (!options.available) {
    const message = `Skipping ffmpeg ${options.operation} because ffmpeg is unavailable.`
    options.warnMissing(message)
    options.onResult?.({ kind: 'spawn-failed', message })
    return false
  }
  if (options.signal?.aborted) {
    options.onResult?.({ kind: 'stopped', reason: 'cancelled' })
    return false
  }

  const clock = dependencies.clock ?? systemClock
  const processRegistry = dependencies.processRegistry
  const spawnProcess = dependencies.spawnProcess ?? spawnFfmpegProcess
  const terminateProcessTree =
    dependencies.terminateProcessTree ?? terminateFfmpegProcessTree

  let proc: FfmpegProcess
  try {
    proc = spawnProcess(options.ffmpegPath, options.args)
  } catch (error) {
    reportSpawnFailure(options, error)
    return false
  }

  return new Promise<boolean>((resolve) => {
    const stderr = new Utf8TailBuffer(32_768)
    let settled = false
    let timeout: NodeJS.Timeout | undefined
    let stopReason: 'cancelled' | 'timeout' | undefined
    let terminationTask: Promise<void> | undefined
    let unregisterProcess = (): void => {}
    let resolveSettlement = (): void => {}
    const settlement = new Promise<void>((resolveSettlementPromise) => {
      resolveSettlement = resolveSettlementPromise
    })

    const settle = (value: boolean): void => {
      if (settled) {
        return
      }

      settled = true
      if (timeout) {
        clock.clearTimeout(timeout)
      }
      options.signal?.removeEventListener('abort', onAbort)
      unregisterProcess()
      resolveSettlement()
      resolve(value)
    }
    const settleStopped = (): void => {
      if (!settled) {
        options.onResult?.({
          kind: 'stopped',
          reason: stopReason ?? 'cancelled',
        })
      }
      settle(false)
    }
    const isSettled = (): boolean => settled

    const terminate = (reason: 'cancelled' | 'timeout' = 'cancelled') => {
      if (settled) {
        return Promise.resolve()
      }
      if (terminationTask) {
        return terminationTask
      }

      stopReason = reason
      terminationTask = terminateFfmpegAfterGrace({
        clock,
        ffmpegProcess: proc,
        isSettled,
        settle: settleStopped,
        settlement,
        terminateProcessTree,
      })
      return terminationTask
    }
    const onAbort = (): void => {
      void terminate()
    }
    unregisterProcess =
      processRegistry?.register({ terminate: () => terminate() }) ?? (() => {})
    options.signal?.addEventListener('abort', onAbort, { once: true })

    if (options.timeoutMs > 0) {
      timeout = clock.setTimeout(() => {
        options.log(
          'warn',
          `[WdioPuppeteerVideoService] ffmpeg ${options.operation} timed out after ${options.timeoutMs.toString()}ms`,
        )
        void terminate('timeout')
      }, options.timeoutMs)
      timeout.unref?.()
    }

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr.append(chunk)
    })

    proc.on('error', (error: Error) => {
      if (settled) {
        return
      }
      if (stopReason) {
        settleStopped()
        return
      }

      reportSpawnFailure(options, error)
      settle(false)
    })

    proc.on('close', (code: number | null, signal?: NodeJS.Signals | null) => {
      if (settled) {
        return
      }
      if (stopReason) {
        settleStopped()
        return
      }

      const output = stderr.finish()
      options.onResult?.({
        kind: 'exited',
        code,
        diagnostic: output.trim(),
        signal: signal ?? null,
      })
      if (code === 0) {
        try {
          options.onStderr?.(output)
        } catch (error) {
          options.log('warn', 'Failed to read FFmpeg diagnostics:', error)
          settle(false)
          return
        }
        settle(true)
        return
      }

      const details = output.trim()
      const suffix = details ? `: ${details}` : ''
      options.log(
        'warn',
        `[WdioPuppeteerVideoService] ffmpeg ${options.operation} exited with code ${String(code)}${suffix}`,
      )
      settle(false)
    })
  })
}

const reportSpawnFailure = (
  options: RunFfmpegOptions,
  error: unknown,
): void => {
  const message = error instanceof Error ? error.message : String(error)
  options.markUnavailable()
  options.warnMissing(`ffmpeg ${options.operation} failed to start: ${message}`)
  options.log(
    'warn',
    `[WdioPuppeteerVideoService] Failed to spawn ffmpeg for ${options.operation}: ${message}`,
  )
  options.onResult?.({
    kind: 'spawn-failed',
    message: `FFmpeg failed to start: ${message}`,
  })
}

interface TerminateFfmpegAfterGraceOptions {
  clock: ClockBoundary
  ffmpegProcess: FfmpegProcess
  isSettled: () => boolean
  settle: (value: boolean) => void
  settlement: Promise<void>
  terminateProcessTree: TerminateFfmpegProcessTree
}

const terminateFfmpegAfterGrace = async (
  options: TerminateFfmpegAfterGraceOptions,
): Promise<void> => {
  await runBoundedTermination(
    () => options.terminateProcessTree(options.ffmpegProcess, false),
    options.clock,
  )
  if (options.isSettled()) {
    return
  }

  await waitForSettlementOrGrace(options.settlement, options.clock)
  if (options.isSettled()) {
    return
  }

  await runBoundedTermination(
    () => options.terminateProcessTree(options.ffmpegProcess, true),
    options.clock,
  )
  options.settle(false)
}

const runBoundedTermination = async (
  terminate: () => Promise<void>,
  clock: ClockBoundary,
): Promise<void> => {
  await waitForTaskOrTimeout(
    Promise.resolve().then(terminate),
    FFMPEG_TERMINATION_HELPER_TIMEOUT_MS,
    clock,
  )
}

const waitForSettlementOrGrace = async (
  settlement: Promise<void>,
  clock: ClockBoundary,
): Promise<void> => {
  await waitForTaskOrTimeout(settlement, FFMPEG_TERMINATION_GRACE_MS, clock)
}

const waitForTaskOrTimeout = async (
  task: Promise<unknown>,
  timeoutMs: number,
  clock: ClockBoundary,
): Promise<void> => {
  await new Promise<void>((resolve) => {
    let settled = false
    let timeout: NodeJS.Timeout | undefined
    const settle = (): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clock.clearTimeout(timeout)
      }
      resolve()
    }
    timeout = clock.setTimeout(settle, timeoutMs)
    timeout.unref?.()
    void task.then(settle, settle)
  })
}
