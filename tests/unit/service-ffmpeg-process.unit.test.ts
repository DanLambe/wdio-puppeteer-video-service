import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

import { FFMPEG_TERMINATION_GRACE_MS } from '../../src/service/constants.js'
import {
  type FfmpegProcess,
  FfmpegProcessRegistry,
  runFfmpeg,
  spawnFfmpegProcess,
} from '../../src/service/ffmpeg-runner.js'

class FakeFfmpegProcess extends EventEmitter implements FfmpegProcess {
  stderr: PassThrough | null = new PassThrough()
  kill = vi.fn((_signal?: NodeJS.Signals | number) => true)
}

const createRunnerHarness = (timeoutMs = 0) => {
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
      expect(process.kill.mock.calls).toEqual([[], ['SIGKILL']])
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
    registry.terminateAll()
    registry.terminateAll()
    expect(process.kill).toHaveBeenCalledOnce()
    process.emit('close', null)

    await expect(resultPromise).resolves.toBe(false)
    expect(registry.size).toBe(0)
  })
})
