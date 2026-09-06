import { type ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import { type ClockBoundary, systemClock } from './boundaries.js'
import { FFMPEG_TERMINATION_HELPER_TIMEOUT_MS } from './constants.js'

export interface FfmpegProcess {
  pid?: number | undefined
  stderr?: NodeJS.ReadableStream | null
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: 'close', listener: (code: number | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
}

interface TerminationHelperProcess {
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: 'close', listener: (code: number | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
}

type SpawnTerminationHelper = (
  command: string,
  args: string[],
) => TerminationHelperProcess

export interface ProcessSupervisorDependencies {
  readonly clock?: ClockBoundary
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void
  readonly platform?: NodeJS.Platform
  readonly spawnTerminationHelper?: SpawnTerminationHelper
  readonly systemRoot?: string
}

export type TerminateFfmpegProcessTree = (
  process: FfmpegProcess,
  force: boolean,
) => Promise<void>

const spawnTerminationHelper: SpawnTerminationHelper = (
  command,
  args,
): ChildProcess => {
  return spawn(command, args, {
    stdio: 'ignore',
    windowsHide: true,
  })
}

export const terminateFfmpegProcessTree = async (
  ffmpegProcess: FfmpegProcess,
  force: boolean,
  dependencies: ProcessSupervisorDependencies = {},
): Promise<void> => {
  const platform = dependencies.platform ?? process.platform
  const signal = force ? 'SIGKILL' : 'SIGTERM'
  const pid = ffmpegProcess.pid

  if (pid && platform === 'win32') {
    const terminated = await terminateWindowsProcessTree(
      pid,
      force,
      dependencies,
    )
    // Windows has no graceful per-process signal: killing the child here is an
    // abrupt single-process terminate that also destroys the parent identity a
    // later `taskkill /T` needs to reach descendants. Leave a failed graceful
    // attempt intact so the caller can still escalate to the whole tree, and
    // signal the child only as the forced pass's last resort.
    if (!terminated && force) {
      killChildBestEffort(ffmpegProcess, signal)
    }
    return
  }

  if (pid) {
    try {
      const killProcessGroup =
        dependencies.killProcessGroup ??
        ((groupPid: number, groupSignal: NodeJS.Signals) => {
          process.kill(groupPid, groupSignal)
        })
      killProcessGroup(-pid, signal)
      return
    } catch {
      // The child may not be a process-group leader; fall back to the child.
    }
  }

  killChildBestEffort(ffmpegProcess, signal)
}

const terminateWindowsProcessTree = async (
  pid: number,
  force: boolean,
  dependencies: ProcessSupervisorDependencies,
): Promise<boolean> => {
  const taskkillPath = path.win32.join(
    dependencies.systemRoot ?? process.env.SystemRoot ?? String.raw`C:\Windows`,
    'System32',
    'taskkill.exe',
  )
  const spawnHelper =
    dependencies.spawnTerminationHelper ?? spawnTerminationHelper
  let helper: TerminationHelperProcess
  try {
    helper = spawnHelper(taskkillPath, [
      '/PID',
      pid.toString(),
      '/T',
      ...(force ? ['/F'] : []),
    ])
  } catch {
    return false
  }

  return waitForTerminationHelper(helper, dependencies.clock ?? systemClock)
}

const waitForTerminationHelper = async (
  helper: TerminationHelperProcess,
  clock: ClockBoundary,
): Promise<boolean> => {
  return new Promise<boolean>((resolve) => {
    let settled = false
    let timeout: NodeJS.Timeout | undefined
    const settle = (terminated: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clock.clearTimeout(timeout)
      }
      resolve(terminated)
    }

    timeout = clock.setTimeout(() => {
      killHelperBestEffort(helper)
      settle(false)
    }, FFMPEG_TERMINATION_HELPER_TIMEOUT_MS)
    timeout.unref?.()
    helper.on('error', () => {
      settle(false)
    })
    helper.on('close', (code) => {
      settle(code === 0)
    })
  })
}

const killChildBestEffort = (
  child: FfmpegProcess,
  signal: NodeJS.Signals,
): void => {
  try {
    child.kill(signal)
  } catch {
    // Process termination is best effort and must never block teardown.
  }
}

const killHelperBestEffort = (helper: TerminationHelperProcess): void => {
  try {
    helper.kill('SIGKILL')
  } catch {
    // A taskkill helper that already exited needs no further cleanup.
  }
}
