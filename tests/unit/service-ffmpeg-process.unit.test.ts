import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

import { FFMPEG_TERMINATION_GRACE_MS } from '../../src/service/constants.js'
import {
  FfmpegProcessRegistry,
  type RunFfmpegOptions,
  runFfmpeg,
  spawnFfmpegProcess,
} from '../../src/service/ffmpeg-runner.js'
import type { FfmpegProcess } from '../../src/service/process-supervisor.js'

class FakeFfmpegProcess extends EventEmitter implements FfmpegProcess {
  pid: number | undefined
  stderr: PassThrough | null = new PassThrough()
  kill = vi.fn((_signal?: NodeJS.Signals | number) => true)
  unref = vi.fn(() => this)
}

const createRunnerHarness = (
  timeoutMs = 0,
  overrides: Partial<RunFfmpegOptions> = {},
) => {
  const warnMessages: string[] = []
  const warnMissing = vi.fn()
  const markUnavailable = vi.fn()
  const run = (process: FakeFfmpegProcess) =>
    runFfmpeg(
      {
        args: ['-i', 'input.webm'],
        available: true,
        ffmpegPath: 'ffmpeg',
        log: (level, message) => {
          if (level === 'warn') {
            warnMessages.push(message)
          }
        },
        markUnavailable,
        operation: 'merge',
        timeoutMs,
        warnMissing,
        ...overrides,
      },
      {
        spawnProcess: () => process,
      },
    )

  return { markUnavailable, run, warnMessages, warnMissing }
}

describe('ffmpeg runner process handling', () => {
  afterEach(() => {
    spawnMock.mockReset()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('hides Windows console windows when spawning ffmpeg', () => {
    const process = new FakeFfmpegProcess()
    spawnMock.mockReturnValue(process)

    expect(spawnFfmpegProcess('ffmpeg', ['-version'])).toBe(process)
    expect(spawnMock).toHaveBeenCalledWith('ffmpeg', ['-version'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: globalThis.process.platform !== 'win32',
      windowsHide: true,
    })
  })

  it('resolves once when a process error is followed by close', async () => {
    const process = new FakeFfmpegProcess()
    const harness = createRunnerHarness()

    const resultPromise = harness.run(process)
    process.emit('error', new Error('spawn failed'))
    process.emit('close', 1)

    await expect(resultPromise).resolves.toBe(false)
    expect(harness.markUnavailable).toHaveBeenCalledTimes(1)
    expect(harness.warnMissing).toHaveBeenCalledTimes(1)
    expect(harness.warnMessages).toHaveLength(1)
    expect(harness.warnMessages[0]).toContain('Failed to spawn ffmpeg')
  })

  it('reports a synchronous process spawn failure without rejecting', async () => {
    const warnMissing = vi.fn()
    const markUnavailable = vi.fn()
    const log = vi.fn()

    await expect(
      runFfmpeg(
        {
          args: [],
          available: true,
          ffmpegPath: 'ffmpeg',
          log,
          markUnavailable,
          operation: 'merge',
          timeoutMs: 0,
          warnMissing,
        },
        {
          spawnProcess: () => {
            throw new Error('synchronous spawn failure')
          },
        },
      ),
    ).resolves.toBe(false)
    expect(markUnavailable).toHaveBeenCalledOnce()
    expect(warnMissing).toHaveBeenCalledWith(
      'ffmpeg merge failed to start: synchronous spawn failure',
    )
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('synchronous spawn failure'),
    )
  })

  it('includes captured stderr when ffmpeg exits nonzero', async () => {
    const process = new FakeFfmpegProcess()
    const harness = createRunnerHarness()

    const resultPromise = harness.run(process)
    process.stderr?.write('muxer failed')
    process.emit('close', 1)

    await expect(resultPromise).resolves.toBe(false)
    expect(harness.warnMessages).toHaveLength(1)
    expect(harness.warnMessages[0]).toContain('muxer failed')
  })

  it('returns successful bounded UTF-8 diagnostics only once', async () => {
    const process = new FakeFfmpegProcess()
    const onStderr = vi.fn()
    const harness = createRunnerHarness(0, { onStderr })
    const result = harness.run(process)
    const output = Buffer.from('Video: 测试, 801x401')
    process.stderr?.write(output.subarray(0, 8))
    process.stderr?.write(output.subarray(8))
    process.emit('close', 0)
    process.emit('close', 0)
    await expect(result).resolves.toBe(true)
    expect(onStderr).toHaveBeenCalledExactlyOnceWith('Video: 测试, 801x401')
  })

  it('settles failure if the diagnostic callback throws', async () => {
    const process = new FakeFfmpegProcess()
    const harness = createRunnerHarness(10, {
      onStderr: () => {
        throw new Error('callback failed')
      },
    })
    const result = harness.run(process)
    process.emit('close', 0)
    await expect(result).resolves.toBe(false)
    expect(harness.warnMessages).toEqual(['Failed to read FFmpeg diagnostics:'])
  })

  it.each([0, 1])(
    'does not deliver metadata after timeout or failed exit %i',
    async (code) => {
      vi.useFakeTimers()
      const process = new FakeFfmpegProcess()
      const onStderr = vi.fn()
      const harness = createRunnerHarness(25, { onStderr })
      const result = harness.run(process)
      if (code === 0) {
        await vi.advanceTimersByTimeAsync(25)
      }
      process.emit('close', code)
      await expect(result).resolves.toBe(false)
      expect(onStderr).not.toHaveBeenCalled()
    },
  )

  it('preserves UTF-8 characters split across stderr chunks', async () => {
    const process = new FakeFfmpegProcess()
    const harness = createRunnerHarness()
    const diagnostic = Buffer.from('muxer 🚨 failed')
    const marker = diagnostic.indexOf(Buffer.from('🚨'))

    const resultPromise = harness.run(process)
    process.stderr?.write(diagnostic.subarray(0, marker + 2))
    process.stderr?.write(diagnostic.subarray(marker + 2))
    process.emit('close', 1)

    await expect(resultPromise).resolves.toBe(false)
    expect(harness.warnMessages[0]).toContain('muxer 🚨 failed')
    expect(harness.warnMessages[0]).not.toContain('\uFFFD')
  })

  it('kills and fails timed out operations', async () => {
    vi.useFakeTimers()
    try {
      const process = new FakeFfmpegProcess()
      const harness = createRunnerHarness(25)

      const resultPromise = harness.run(process)
      await vi.advanceTimersByTimeAsync(25)

      expect(process.kill).toHaveBeenCalledTimes(1)
      process.emit('close', 0)

      await expect(resultPromise).resolves.toBe(false)
      expect(harness.warnMessages).toEqual([
        '[WdioPuppeteerVideoService] ffmpeg merge timed out after 25ms',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('force-kills a timed out process that does not close', async () => {
    vi.useFakeTimers()
    try {
      const process = new FakeFfmpegProcess()
      const harness = createRunnerHarness(25)

      const resultPromise = harness.run(process)
      await vi.advanceTimersByTimeAsync(25 + FFMPEG_TERMINATION_GRACE_MS)

      await expect(resultPromise).resolves.toBe(false)
      expect(process.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not spawn when ffmpeg is unavailable', async () => {
    const warnMissing = vi.fn()
    const spawnProcess = vi.fn()

    await expect(
      runFfmpeg(
        {
          args: [],
          available: false,
          ffmpegPath: 'ffmpeg',
          log: () => {},
          markUnavailable: () => {},
          operation: 'merge',
          timeoutMs: 0,
          warnMissing,
        },
        { spawnProcess },
      ),
    ).resolves.toBe(false)
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(warnMissing).toHaveBeenCalledOnce()
  })

  it('terminates the complete process tree before force-killing it', async () => {
    vi.useFakeTimers()
    const process = new FakeFfmpegProcess()
    const terminateProcessTree = vi.fn(async () => {})
    const resultPromise = runFfmpeg(
      {
        args: [],
        available: true,
        ffmpegPath: 'ffmpeg',
        log: () => {},
        markUnavailable: () => {},
        operation: 'transcode',
        timeoutMs: 10,
        warnMissing: () => {},
      },
      {
        spawnProcess: () => process,
        terminateProcessTree,
      },
    )

    await vi.advanceTimersByTimeAsync(10 + FFMPEG_TERMINATION_GRACE_MS)

    await expect(resultPromise).resolves.toBe(false)
    expect(terminateProcessTree.mock.calls).toEqual([
      [process, false],
      [process, true],
    ])
  })

  it('terminates registered processes during service teardown', async () => {
    const process = new FakeFfmpegProcess()
    const registry = new FfmpegProcessRegistry()
    const harness = createRunnerHarness()

    const resultPromise = runFfmpeg(
      {
        args: ['-i', 'input.webm'],
        available: true,
        ffmpegPath: 'ffmpeg',
        log: () => {},
        markUnavailable: harness.markUnavailable,
        operation: 'merge',
        timeoutMs: 0,
        warnMissing: harness.warnMissing,
      },
      {
        processRegistry: registry,
        spawnProcess: () => process,
      },
    )

    expect(registry.size).toBe(1)
    const firstTermination = registry.terminateAll()
    const repeatedTermination = registry.terminateAll()
    await vi.waitFor(() => {
      expect(process.kill).toHaveBeenCalledOnce()
    })
    process.emit('close', null)

    await Promise.all([firstTermination, repeatedTermination])
    await expect(resultPromise).resolves.toBe(false)
    expect(registry.size).toBe(0)
  })
})

describe('ffmpeg runner results', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const runWithResult = (
    process: FakeFfmpegProcess | undefined,
    overrides: Partial<RunFfmpegOptions> = {},
    registry?: FfmpegProcessRegistry,
  ) => {
    const onResult = vi.fn<NonNullable<RunFfmpegOptions['onResult']>>()
    const spawnProcess = vi.fn(() => {
      if (!process) {
        throw new Error('ENOENT')
      }
      return process
    })
    const result = runFfmpeg(
      {
        args: [],
        available: true,
        ffmpegPath: 'ffmpeg',
        log: () => {},
        markUnavailable: () => {},
        onResult,
        operation: 'spool encode',
        timeoutMs: 0,
        warnMissing: () => {},
        ...overrides,
      },
      {
        ...(registry ? { processRegistry: registry } : {}),
        spawnProcess,
        terminateProcessTree: async () => {
          process?.emit('close', null, 'SIGTERM')
        },
      },
    )
    return { onResult, result, spawnProcess }
  }

  it.each([
    [0, null, true],
    [1, null, false],
    [null, 'SIGKILL', false],
  ] as const)(
    'reports an exit with code %s and signal %s with its diagnostic',
    async (code, signal, succeeded) => {
      const process = new FakeFfmpegProcess()
      const run = runWithResult(process)
      process.stderr?.write('  encoder said this \n')
      process.emit('close', code, signal)

      await expect(run.result).resolves.toBe(succeeded)
      expect(run.onResult.mock.calls).toEqual([
        [{ code, diagnostic: 'encoder said this', kind: 'exited', signal }],
      ])
    },
  )

  it('reports a spawn failure and an unavailable FFmpeg', async () => {
    const failed = runWithResult(undefined)
    await expect(failed.result).resolves.toBe(false)
    expect(failed.onResult.mock.calls).toEqual([
      [{ kind: 'spawn-failed', message: 'FFmpeg failed to start: ENOENT' }],
    ])

    const unavailable = runWithResult(new FakeFfmpegProcess(), {
      available: false,
    })
    await expect(unavailable.result).resolves.toBe(false)
    expect(unavailable.spawnProcess).not.toHaveBeenCalled()
    expect(unavailable.onResult).toHaveBeenCalledWith({
      kind: 'spawn-failed',
      message: 'Skipping ffmpeg spool encode because ffmpeg is unavailable.',
    })
  })

  it('never spawns for a signal already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = runWithResult(new FakeFfmpegProcess(), {
      signal: controller.signal,
    })

    await expect(run.result).resolves.toBe(false)
    expect(run.spawnProcess).not.toHaveBeenCalled()
    expect(run.onResult.mock.calls).toEqual([
      [{ kind: 'stopped', reason: 'cancelled' }],
    ])
  })

  it('stops a running process when its signal aborts', async () => {
    const controller = new AbortController()
    const registry = new FfmpegProcessRegistry()
    const run = runWithResult(
      new FakeFfmpegProcess(),
      { signal: controller.signal },
      registry,
    )
    controller.abort()

    await expect(run.result).resolves.toBe(false)
    expect(run.onResult.mock.calls).toEqual([
      [{ kind: 'stopped', reason: 'cancelled' }],
    ])
    expect(registry.size).toBe(0)
  })

  it('tells its own timeout from a shutdown', async () => {
    vi.useFakeTimers()
    const timedOut = runWithResult(new FakeFfmpegProcess(), { timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(10)
    await expect(timedOut.result).resolves.toBe(false)
    expect(timedOut.onResult.mock.calls).toEqual([
      [{ kind: 'stopped', reason: 'timeout' }],
    ])
    vi.useRealTimers()

    const registry = new FfmpegProcessRegistry()
    const shutDown = runWithResult(new FakeFfmpegProcess(), {}, registry)
    await registry.terminateAll()
    await expect(shutDown.result).resolves.toBe(false)
    expect(shutDown.onResult.mock.calls).toEqual([
      [{ kind: 'stopped', reason: 'cancelled' }],
    ])
  })

  it('reports a stopped process whose error follows the stop', async () => {
    const controller = new AbortController()
    const process = new FakeFfmpegProcess()
    const onResult = vi.fn()
    const result = runFfmpeg(
      {
        args: [],
        available: true,
        ffmpegPath: 'ffmpeg',
        log: () => {},
        markUnavailable: () => {},
        onResult,
        operation: 'spool encode',
        signal: controller.signal,
        timeoutMs: 0,
        warnMissing: () => {},
      },
      {
        spawnProcess: () => process,
        terminateProcessTree: async () => {
          process.emit('error', new Error('kill failed'))
        },
      },
    )
    controller.abort()

    await expect(result).resolves.toBe(false)
    expect(onResult.mock.calls).toEqual([
      [{ kind: 'stopped', reason: 'cancelled' }],
    ])
  })
})
