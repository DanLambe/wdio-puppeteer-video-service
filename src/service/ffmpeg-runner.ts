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

export interface RunFfmpegOptions {
  args: string[]
  available: boolean
  ffmpegPath: string
  log: ServiceLogger
  markUnavailable: () => void
  operation: string
  onStderr?: (output: string) => void
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
    options.warnMissing(
      `Skipping ffmpeg ${options.operation} because ffmpeg is unavailable.`,
    )
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
    let timedOut = false
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
      unregisterProcess()
      resolveSettlement()
      resolve(value)
    }
    const isSettled = (): boolean => settled

    const terminate = (): Promise<void> => {
      if (settled) {
        return Promise.resolve()
      }
      if (terminationTask) {
        return terminationTask
      }

      timedOut = true
      terminationTask = terminateFfmpegAfterGrace({
        clock,
        ffmpegProcess: proc,
        isSettled,
        settle,
        settlement,
        terminateProcessTree,
      })
      return terminationTask
    }
    unregisterProcess = processRegistry?.register({ terminate }) ?? (() => {})

    if (options.timeoutMs > 0) {
      timeout = clock.setTimeout(() => {
        options.log(
          'warn',
          `[WdioPuppeteerVideoService] ffmpeg ${options.operation} timed out after ${options.timeoutMs.toString()}ms`,
        )
        void terminate()
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
      if (timedOut) {
        settle(false)
        return
      }

      reportSpawnFailure(options, error)
      settle(false)
    })

    proc.on('close', (code: number | null) => {
      if (settled) {
        return
      }
      if (timedOut) {
        settle(false)
        return
      }

      if (code === 0) {
        try {
          options.onStderr?.(stderr.finish())
        } catch (error) {
          options.log('warn', 'Failed to read FFmpeg diagnostics:', error)
          settle(false)
          return
        }
        settle(true)
        return
      }

      const details = stderr.finish().trim()
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
