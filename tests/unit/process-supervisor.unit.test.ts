import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

import { FFMPEG_TERMINATION_HELPER_TIMEOUT_MS } from '../../src/service/constants.js'
import {
  type FfmpegProcess,
  terminateFfmpegProcessTree,
} from '../../src/service/process-supervisor.js'

class FakeProcess extends EventEmitter implements FfmpegProcess {
  pid: number | undefined
  stderr = null
  kill = vi.fn((_signal?: NodeJS.Signals | number) => true)
}

class FakeTerminationHelper extends EventEmitter {
  kill = vi.fn((_signal?: NodeJS.Signals | number) => true)
}

describe('FFmpeg process supervisor', () => {
  afterEach(() => {
    spawnMock.mockReset()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('spawns the default hidden Windows taskkill helper', async () => {
    const process = new FakeProcess()
    process.pid = 4321
    const helper = new FakeTerminationHelper()
    spawnMock.mockReturnValue(helper)
    vi.spyOn(globalThis.process, 'platform', 'get').mockReturnValue('win32')

    const termination = terminateFfmpegProcessTree(process, false, {
      systemRoot: String.raw`D:\Windows`,
    })
    helper.emit('close', 0)

    await expect(termination).resolves.toBeUndefined()
    expect(spawnMock).toHaveBeenCalledWith(
      String.raw`D:\Windows\System32\taskkill.exe`,
      ['/PID', '4321', '/T'],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    )
    expect(process.kill).not.toHaveBeenCalled()
  })

  it('falls back to the standard Windows root when SystemRoot is unavailable', async () => {
    const previousSystemRoot = globalThis.process.env.SystemRoot
    Reflect.deleteProperty(globalThis.process.env, 'SystemRoot')
    try {
      const process = new FakeProcess()
      process.pid = 4321
      const helper = new FakeTerminationHelper()
      spawnMock.mockReturnValue(helper)

      const termination = terminateFfmpegProcessTree(process, true, {
        platform: 'win32',
      })
      helper.emit('close', 0)

      await expect(termination).resolves.toBeUndefined()
      expect(spawnMock).toHaveBeenCalledWith(
        String.raw`C:\Windows\System32\taskkill.exe`,
        ['/PID', '4321', '/T', '/F'],
        {
          stdio: 'ignore',
          windowsHide: true,
        },
      )
    } finally {
      if (previousSystemRoot === undefined) {
        Reflect.deleteProperty(globalThis.process.env, 'SystemRoot')
      } else {
        globalThis.process.env.SystemRoot = previousSystemRoot
      }
    }
  })

  it('awaits graceful Windows tree termination without killing the child directly', async () => {
    const process = new FakeProcess()
    process.pid = 4321
    const helper = new FakeTerminationHelper()
    const spawnTerminationHelper = vi.fn(() => helper)

    const termination = terminateFfmpegProcessTree(process, false, {
      platform: 'win32',
      systemRoot: String.raw`D:\Windows`,
      spawnTerminationHelper,
    })
    helper.emit('close', 0)

    await expect(termination).resolves.toBeUndefined()
    expect(spawnTerminationHelper).toHaveBeenCalledWith(
      String.raw`D:\Windows\System32\taskkill.exe`,
      ['/PID', '4321', '/T'],
    )
    expect(process.kill).not.toHaveBeenCalled()
  })

  it('uses forceful Windows tree termination only when requested', async () => {
    const process = new FakeProcess()
    process.pid = 4321
    const helper = new FakeTerminationHelper()
    const spawnTerminationHelper = vi.fn(() => helper)

    const termination = terminateFfmpegProcessTree(process, true, {
      platform: 'win32',
      systemRoot: String.raw`C:\Windows`,
      spawnTerminationHelper,
    })
    helper.emit('close', 0)

    await termination
    expect(spawnTerminationHelper).toHaveBeenCalledWith(
      String.raw`C:\Windows\System32\taskkill.exe`,
      ['/PID', '4321', '/T', '/F'],
    )
    expect(process.kill).not.toHaveBeenCalled()
  })

  it('bounds a hung Windows helper and falls back to the child', async () => {
    vi.useFakeTimers()
    const process = new FakeProcess()
    process.pid = 4321
    const helper = new FakeTerminationHelper()

    const termination = terminateFfmpegProcessTree(process, false, {
      platform: 'win32',
      spawnTerminationHelper: () => helper,
    })
    await vi.advanceTimersByTimeAsync(FFMPEG_TERMINATION_HELPER_TIMEOUT_MS)

    await expect(termination).resolves.toBeUndefined()
    expect(helper.kill).toHaveBeenCalledWith('SIGKILL')
    expect(process.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('falls back when the Windows helper errors or exits unsuccessfully', async () => {
    const erroredProcess = new FakeProcess()
    erroredProcess.pid = 1001
    const erroredHelper = new FakeTerminationHelper()
    const erroredTermination = terminateFfmpegProcessTree(
      erroredProcess,
      false,
      {
        platform: 'win32',
        spawnTerminationHelper: () => erroredHelper,
      },
    )
    erroredHelper.emit('error', new Error('taskkill failed'))
    erroredHelper.emit('close', 0)

    const failedProcess = new FakeProcess()
    failedProcess.pid = 1002
    const failedHelper = new FakeTerminationHelper()
    const failedTermination = terminateFfmpegProcessTree(failedProcess, true, {
      platform: 'win32',
      spawnTerminationHelper: () => failedHelper,
    })
    failedHelper.emit('close', 1)

    await Promise.all([erroredTermination, failedTermination])
    expect(erroredProcess.kill).toHaveBeenCalledWith('SIGTERM')
    expect(failedProcess.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('falls back when spawning the Windows helper throws', async () => {
    const process = new FakeProcess()
    process.pid = 4321

    await expect(
      terminateFfmpegProcessTree(process, true, {
        platform: 'win32',
        spawnTerminationHelper: () => {
          throw new Error('spawn failed')
        },
      }),
    ).resolves.toBeUndefined()
    expect(process.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('ignores a helper kill failure when the helper timeout expires', async () => {
    vi.useFakeTimers()
    const process = new FakeProcess()
    process.pid = 4321
    const helper = new FakeTerminationHelper()
    helper.kill.mockImplementation(() => {
      throw new Error('helper already exited')
    })

    const termination = terminateFfmpegProcessTree(process, true, {
      platform: 'win32',
      spawnTerminationHelper: () => helper,
    })
    await vi.advanceTimersByTimeAsync(FFMPEG_TERMINATION_HELPER_TIMEOUT_MS)

    await expect(termination).resolves.toBeUndefined()
    expect(process.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('signals a POSIX process group for graceful and forceful termination', async () => {
    const process = new FakeProcess()
    process.pid = 4321
    const killProcessGroup = vi.fn()

    await terminateFfmpegProcessTree(process, false, {
      platform: 'linux',
      killProcessGroup,
    })
    await terminateFfmpegProcessTree(process, true, {
      platform: 'linux',
      killProcessGroup,
    })

    expect(killProcessGroup.mock.calls).toEqual([
      [-4321, 'SIGTERM'],
      [-4321, 'SIGKILL'],
    ])
    expect(process.kill).not.toHaveBeenCalled()
  })

  it('uses the default Node process-group signal boundary on POSIX', async () => {
    const process = new FakeProcess()
    process.pid = 4321
    const killProcessGroup = vi
      .spyOn(globalThis.process, 'kill')
      .mockReturnValue(true)

    await expect(
      terminateFfmpegProcessTree(process, false, { platform: 'linux' }),
    ).resolves.toBeUndefined()
    expect(killProcessGroup).toHaveBeenCalledWith(-4321, 'SIGTERM')
    expect(process.kill).not.toHaveBeenCalled()
  })

  it('falls back to the POSIX child when group signaling fails', async () => {
    const process = new FakeProcess()
    process.pid = 4321

    await expect(
      terminateFfmpegProcessTree(process, false, {
        platform: 'linux',
        killProcessGroup: () => {
          throw new Error('not a process-group leader')
        },
      }),
    ).resolves.toBeUndefined()
    expect(process.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('terminates a PID-less child and tolerates a child kill failure', async () => {
    const process = new FakeProcess()
    process.kill.mockImplementation(() => {
      throw new Error('already exited')
    })

    await expect(
      terminateFfmpegProcessTree(process, true, { platform: 'linux' }),
    ).resolves.toBeUndefined()
    expect(process.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
