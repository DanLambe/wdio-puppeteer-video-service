import { type ChildProcess, spawn } from 'node:child_process'
import { type ClockBoundary, systemClock } from './boundaries.js'
import { FFMPEG_TERMINATION_GRACE_MS } from './constants.js'
import type { ServiceLogger } from './logging.js'

export interface FfmpegProcess {
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
  spawnProcess?: SpawnFfmpegProcess
}

export const spawnFfmpegProcess: SpawnFfmpegProcess = (
  ffmpegPath,
  args,
): ChildProcess => {
  return spawn(ffmpegPath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
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
  const spawnProcess = dependencies.spawnProcess ?? spawnFfmpegProcess

  return new Promise<boolean>((resolve) => {
    const proc = spawnProcess(options.ffmpegPath, options.args)
    let stderr = ''
    let settled = false
    let timeout: NodeJS.Timeout | undefined
    let terminationTimeout: NodeJS.Timeout | undefined
    let timedOut = false

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
      resolve(value)
    }

    if (options.timeoutMs > 0) {
      timeout = clock.setTimeout(() => {
        timedOut = true
        options.log(
          'warn',
          `[WdioPuppeteerVideoService] ffmpeg ${options.operation} timed out after ${options.timeoutMs.toString()}ms`,
        )
        proc.kill()
        terminationTimeout = clock.setTimeout(() => {
          proc.kill('SIGKILL')
          settle(false)
        }, FFMPEG_TERMINATION_GRACE_MS)
        terminationTimeout.unref?.()
      }, options.timeoutMs)
      timeout.unref?.()
    }

    proc.stderr?.on('data', (chunk: Buffer) => {
      const next = stderr + chunk.toString('utf8')
      stderr = next.length > 32_768 ? next.slice(-32_768) : next
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

      const details = stderr.trim()
      const suffix = details ? `: ${details}` : ''
      options.log(
        'warn',
        `[WdioPuppeteerVideoService] ffmpeg ${options.operation} exited with code ${String(code)}${suffix}`,
      )
      settle(false)
    })
  })
}
