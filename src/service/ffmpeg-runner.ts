import { type ChildProcess, spawn } from 'node:child_process'
import { type ClockBoundary, systemClock } from './boundaries.js'
import { FFMPEG_TERMINATION_GRACE_MS } from './constants.js'
import type { ServiceLogger } from './logging.js'
import { Utf8TailBuffer } from './utf8-tail-buffer.js'

export interface FfmpegProcess {
  pid?: number | undefined
  stderr?: NodeJS.ReadableStream | null
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: 'close', listener: (code: number | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
}

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
  timeoutMs: number
  warnMissing: (reason: string) => void
}

export interface FfmpegRunnerDependencies {
  clock?: ClockBoundary
  processRegistry?: FfmpegProcessRegistry
  spawnProcess?: SpawnFfmpegProcess
  terminateProcessTree?: TerminateFfmpegProcessTree
}

export type TerminateFfmpegProcessTree = (
  process: FfmpegProcess,
  force: boolean,
) => void

interface RegisteredFfmpegProcess {
  terminate: () => void
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

  terminateAll(): void {
    for (const process of [...this.activeProcesses]) {
      process.terminate()
    }
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

export const terminateFfmpegProcessTree: TerminateFfmpegProcessTree = (
  ffmpegProcess,
  force,
): void => {
  const pid = ffmpegProcess.pid
  if (pid && process.platform === 'win32') {
    const terminator = spawn(
      'taskkill',
      ['/PID', pid.toString(), '/T', ...(force ? ['/F'] : [])],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    )
    terminator.on('error', () => {
      ffmpegProcess.kill(force ? 'SIGKILL' : 'SIGTERM')
    })
    terminator.unref()
    return
  }

  if (pid) {
    try {
      process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
      return
    } catch {
      /* fall back when the child is not a process-group leader */
    }
  }

  ffmpegProcess.kill(force ? 'SIGKILL' : 'SIGTERM')
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

  return new Promise<boolean>((resolve) => {
    const proc = spawnProcess(options.ffmpegPath, options.args)
    const stderr = new Utf8TailBuffer(32_768)
    let settled = false
    let timeout: NodeJS.Timeout | undefined
    let terminationTimeout: NodeJS.Timeout | undefined
    let timedOut = false
    let unregisterProcess = (): void => {}

    const settle = (value: boolean): void => {
      if (settled) {
        return
      }

      settled = true
      if (timeout) {
        clock.clearTimeout(timeout)
      }
      if (terminationTimeout) {
        clock.clearTimeout(terminationTimeout)
      }
      unregisterProcess()
      resolve(value)
    }

    const terminate = (): void => {
      if (settled || timedOut) {
        return
      }

      timedOut = true
      terminateProcessTree(proc, false)
      terminationTimeout = clock.setTimeout(() => {
        terminateProcessTree(proc, true)
        settle(false)
      }, FFMPEG_TERMINATION_GRACE_MS)
      terminationTimeout.unref?.()
    }
    unregisterProcess = processRegistry?.register({ terminate }) ?? (() => {})

    if (options.timeoutMs > 0) {
      timeout = clock.setTimeout(() => {
        options.log(
          'warn',
          `[WdioPuppeteerVideoService] ffmpeg ${options.operation} timed out after ${options.timeoutMs.toString()}ms`,
        )
        terminate()
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

      options.markUnavailable()
      options.warnMissing(
        `ffmpeg ${options.operation} failed to start: ${error.message}`,
      )
      options.log(
        'warn',
        `[WdioPuppeteerVideoService] Failed to spawn ffmpeg for ${options.operation}: ${error.message}`,
      )
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
