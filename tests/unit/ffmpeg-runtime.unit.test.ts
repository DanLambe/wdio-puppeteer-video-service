import { describe, expect, it, vi } from 'vitest'
import type { ProcessBoundary } from '../../src/service/boundaries.js'
import type {
  getFfmpegCandidates,
  probeDirectMp4Support,
  readFfmpegVersion,
  resolveAvailableFfmpegPath,
} from '../../src/service/ffmpeg.js'
import { FfmpegProcessRegistry } from '../../src/service/ffmpeg-runner.js'
import {
  type FfmpegRunner,
  FfmpegRuntime,
} from '../../src/service/ffmpeg-runtime.js'
import type { ServiceLogger } from '../../src/service/logging.js'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import type { PostProcessSlotScheduler } from '../../src/service/recording-slots.js'
import type { WdioPuppeteerVideoServiceOptions } from '../../src/types.js'

interface SchedulerHarness {
  acquire: ReturnType<typeof vi.fn<() => Promise<boolean>>>
  ownsGlobalPostProcessSlot: boolean
  ownsPostProcessSlot: boolean
  release: ReturnType<typeof vi.fn<() => Promise<void>>>
}

const createScheduler = (): SchedulerHarness => ({
  acquire: vi.fn(async () => true),
  ownsGlobalPostProcessSlot: false,
  ownsPostProcessSlot: false,
  release: vi.fn(async () => {}),
})

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const createHarness = (
  serviceOptions: WdioPuppeteerVideoServiceOptions = {},
  environment: Readonly<Record<string, string | undefined>> = {},
) => {
  const scheduler = createScheduler()
  const processRegistry = new FfmpegProcessRegistry()
  const processBoundary: ProcessBoundary = {
    environment: (name) => environment[name],
    isAlive: () => true,
    pid: 123,
    platform: 'linux',
  }
  const getCandidates = vi.fn<typeof getFfmpegCandidates>(
    (
      _configuredPath: string | undefined,
      _environmentPath: string | undefined,
    ) => ['/detected/ffmpeg'],
  )
  const resolveAvailablePath = vi.fn<typeof resolveAvailableFfmpegPath>(
    async () => '/detected/ffmpeg',
  )
  const readVersion = vi.fn<typeof readFfmpegVersion>(async () => '7.1')
  const probeDirectMp4 = vi.fn<typeof probeDirectMp4Support>(async () => true)
  const runFfmpeg = vi.fn<FfmpegRunner>(async () => true)
  const log = vi.fn<ServiceLogger>()
  const onVersion = vi.fn(async () => {})
  const createPostProcessSlotScheduler = vi.fn(
    () => scheduler as unknown as PostProcessSlotScheduler,
  )
  const runtime = new FfmpegRuntime({
    createPostProcessSlotScheduler,
    getCandidates,
    log,
    onVersion,
    options: resolveServiceConfiguration(serviceOptions).options,
    probeDirectMp4,
    process: processBoundary,
    processRegistry,
    readVersion,
    resolveAvailablePath,
    runFfmpeg,
  })

  return {
    createPostProcessSlotScheduler,
    getCandidates,
    log,
    onVersion,
    probeDirectMp4,
    processRegistry,
    readVersion,
    resolveAvailablePath,
    runFfmpeg,
    runtime,
    scheduler,
  }
}

describe('FfmpegRuntime', () => {
  it.each([
    [0, 5_000],
    [250, 250],
    [30_000, 5_000],
  ])(
    'reads dimensions under the post-process lease with timeout %i bounded to %i',
    async (configuredTimeout, expectedTimeout) => {
      const harness = createHarness({
        processing: { ffmpeg: { timeoutMs: configuredTimeout } },
      })
      harness.runFfmpeg.mockImplementation(async (options) => {
        expect(harness.scheduler.acquire).toHaveBeenCalledOnce()
        expect(harness.scheduler.release).not.toHaveBeenCalled()
        options.onStderr?.('Stream #0:0: Video: h264, yuv420p, 802x402')
        return true
      })

      await expect(
        harness.runtime.readMediaDimensions('/video.mp4'),
      ).resolves.toEqual({ width: 802, height: 402 })
      expect(harness.runFfmpeg).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'metadata probe',
          timeoutMs: expectedTimeout,
        }),
        harness.processRegistry,
      )
      expect(harness.scheduler.release).toHaveBeenCalledOnce()
    },
  )

  it.each([false, true])(
    'omits dimensions when the probe success is %s but metadata is unavailable',
    async (success) => {
      const harness = createHarness()
      harness.runFfmpeg.mockImplementation(async (options) => {
        options.onStderr?.(
          success ? 'no video stream' : 'Stream #0:0: Video: vp9, 800x600',
        )
        return success
      })
      await expect(
        harness.runtime.readMediaDimensions('/video.webm'),
      ).resolves.toBeUndefined()
      expect(harness.scheduler.release).toHaveBeenCalledOnce()
      expect(harness.log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('omitting optional manifest dimensions'),
      )
    },
  )

  it('preserves media when dimension probing throws', async () => {
    const harness = createHarness()
    const failure = new Error('probe failed')
    harness.runFfmpeg.mockRejectedValue(failure)
    await expect(
      harness.runtime.readMediaDimensions('/video.webm'),
    ).resolves.toBeUndefined()
    expect(harness.scheduler.release).toHaveBeenCalledOnce()
    expect(harness.log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('preserving media'),
      failure,
    )
  })

  it('does not start a metadata probe without FFmpeg or post-processing capacity', async () => {
    const unavailable = createHarness()
    unavailable.resolveAvailablePath.mockResolvedValue(undefined)
    await expect(
      unavailable.runtime.readMediaDimensions('/video.webm'),
    ).resolves.toBeUndefined()
    expect(unavailable.scheduler.acquire).not.toHaveBeenCalled()
    expect(unavailable.runFfmpeg).not.toHaveBeenCalled()

    const noCapacity = createHarness()
    noCapacity.scheduler.acquire.mockResolvedValue(false)
    await expect(
      noCapacity.runtime.readMediaDimensions('/video.webm'),
    ).resolves.toBeUndefined()
    expect(noCapacity.runFfmpeg).not.toHaveBeenCalled()
    expect(noCapacity.scheduler.release).not.toHaveBeenCalled()
  })

  it('initializes lazily, deduplicates concurrent discovery, and reports the version', async () => {
    const harness = createHarness()
    let finishDiscovery: ((path: string | undefined) => void) | undefined
    harness.resolveAvailablePath.mockReturnValue(
      new Promise<string | undefined>((resolve) => {
        finishDiscovery = (path) => {
          resolve(path)
        }
      }),
    )

    expect(harness.getCandidates).not.toHaveBeenCalled()
    const first = harness.runtime.ensureReady()
    const second = harness.runtime.ensureReady()
    expect(harness.getCandidates).toHaveBeenCalledOnce()
    expect(harness.resolveAvailablePath).toHaveBeenCalledOnce()

    finishDiscovery?.('/detected/ffmpeg')
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(harness.readVersion).toHaveBeenCalledWith('/detected/ffmpeg')
    expect(harness.onVersion).toHaveBeenCalledWith('7.1')
    expect(harness.log).toHaveBeenCalledWith(
      'info',
      '[WdioPuppeteerVideoService] Using ffmpeg binary: /detected/ffmpeg',
    )

    await expect(harness.runtime.ensureReady()).resolves.toBe(true)
    expect(harness.resolveAvailablePath).toHaveBeenCalledOnce()
  })

  it('retries discovery after teardown interrupts initialization', async () => {
    const harness = createHarness()
    let finishDiscovery: ((path: string | undefined) => void) | undefined
    harness.resolveAvailablePath.mockReturnValueOnce(
      new Promise<string | undefined>((resolve) => {
        finishDiscovery = resolve
      }),
    )

    const initialization = harness.runtime.ensureReady()
    await harness.runtime.terminateAll()
    finishDiscovery?.('/detected/ffmpeg')
    await expect(initialization).resolves.toBe(false)

    harness.runtime.resumeAfterTeardown()
    await expect(harness.runtime.ensureReady()).resolves.toBe(true)
    expect(harness.resolveAvailablePath).toHaveBeenCalledTimes(2)
  })

  it('resolves discovered, configured, environment, and PATH binaries in order', async () => {
    const configured = createHarness(
      { processing: { ffmpeg: { path: ' /configured/ffmpeg ' } } },
      { FFMPEG_PATH: ' /environment/ffmpeg ' },
    )
    expect(configured.runtime.resolvePath()).toBe('/configured/ffmpeg')
    await configured.runtime.ensureReady()
    expect(configured.runtime.resolvePath()).toBe('/detected/ffmpeg')
    expect(configured.getCandidates).toHaveBeenCalledWith(
      '/configured/ffmpeg',
      '/environment/ffmpeg',
    )

    const environmentOnly = createHarness({}, { FFMPEG_PATH: ' /env/ffmpeg ' })
    expect(environmentOnly.runtime.resolvePath()).toBe('/env/ffmpeg')
    expect(createHarness().runtime.resolvePath()).toBe('ffmpeg')
  })

  it('reports an unavailable binary once and does not repeat failed discovery', async () => {
    const harness = createHarness(
      { processing: { ffmpeg: { path: '/missing/ffmpeg' } } },
      { FFMPEG_PATH: '/also/missing' },
    )
    harness.getCandidates.mockReturnValue([
      '/missing/ffmpeg',
      '/also/missing',
      'ffmpeg',
    ])
    harness.resolveAvailablePath.mockResolvedValue(undefined)

    await expect(harness.runtime.ensureReady()).resolves.toBe(false)
    await expect(harness.runtime.ensureReady()).resolves.toBe(false)
    expect(harness.resolveAvailablePath).toHaveBeenCalledOnce()
    expect(harness.log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining(
        'Configured processing.ffmpeg.path: /missing/ffmpeg. Checked candidates: /missing/ffmpeg, /also/missing, ffmpeg.',
      ),
    )
    expect(
      harness.log.mock.calls.filter(([, message]) =>
        message.includes('FFmpeg is required but unavailable'),
      ),
    ).toHaveLength(1)
  })

  it('handles unavailable default discovery and an absent version', async () => {
    const unavailable = createHarness()
    unavailable.getCandidates.mockReturnValue([])
    unavailable.resolveAvailablePath.mockResolvedValue(undefined)
    await unavailable.runtime.ensureReady()
    expect(unavailable.log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining(
        'No processing.ffmpeg.path was provided. Install FFmpeg and make it available',
      ),
    )

    const unversioned = createHarness()
    unversioned.readVersion.mockResolvedValue(undefined)
    await unversioned.runtime.ensureReady()
    expect(unversioned.onVersion).not.toHaveBeenCalled()
  })

  it('resets only per-session discovery state', async () => {
    const harness = createHarness({ processing: { format: 'mp4' } })
    harness.probeDirectMp4.mockResolvedValue(false)

    await harness.runtime.ensureReady()
    expect(harness.runtime.shouldTranscode('mp4')).toBe(true)
    harness.runtime.resetForSession()
    await harness.runtime.ensureReady()

    expect(harness.resolveAvailablePath).toHaveBeenCalledTimes(2)
    expect(harness.probeDirectMp4).toHaveBeenCalledTimes(2)
    expect(
      harness.log.mock.calls.filter(([, message]) =>
        message.includes('Falling back to MP4 transcode mode'),
      ),
    ).toHaveLength(1)
  })

  it('passes execution state to the runner and marks spawn failures unavailable', async () => {
    const harness = createHarness({
      processing: { ffmpeg: { timeoutMs: 321 } },
    })
    await harness.runtime.ensureReady()
    harness.runFfmpeg.mockImplementation(async (options) => {
      options.markUnavailable()
      options.warnMissing('spawn failed')
      options.warnMissing('duplicate failure')
      return false
    })

    await expect(harness.runtime.run(['-version'], 'test probe')).resolves.toBe(
      false,
    )
    expect(harness.runFfmpeg).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['-version'],
        available: true,
        ffmpegPath: '/detected/ffmpeg',
        operation: 'test probe',
        timeoutMs: 321,
      }),
      harness.processRegistry,
    )
    await expect(harness.runtime.ensureReady()).resolves.toBe(false)
    expect(
      harness.log.mock.calls.filter(([, message]) =>
        message.includes('FFmpeg is required but unavailable'),
      ),
    ).toHaveLength(1)
  })

  it('does not transcode webm or probe direct MP4 support', async () => {
    const harness = createHarness()
    await harness.runtime.ensureReady()

    expect(harness.runtime.shouldTranscode('webm')).toBe(false)
    expect(harness.runtime.shouldTranscode('mp4')).toBe(false)
    expect(harness.probeDirectMp4).not.toHaveBeenCalled()
    expect(harness.scheduler.acquire).not.toHaveBeenCalled()
  })

  it('honors explicit transcode configuration without probing', async () => {
    const harness = createHarness({
      processing: {
        format: 'mp4',
        mp4Mode: 'direct',
        transcode: { enabled: true },
      },
    })
    await harness.runtime.ensureReady()

    expect(harness.runtime.shouldTranscode('mp4')).toBe(true)
    expect(harness.probeDirectMp4).not.toHaveBeenCalled()
  })

  it('honors transcode mode without probing', async () => {
    const harness = createHarness({
      processing: { format: 'mp4', mp4Mode: 'transcode' },
    })
    await harness.runtime.ensureReady()

    expect(harness.runtime.shouldTranscode('mp4')).toBe(true)
    expect(harness.probeDirectMp4).not.toHaveBeenCalled()
    expect(harness.log).toHaveBeenCalledWith(
      'info',
      '[WdioPuppeteerVideoService] MP4 strategy is set to transcode mode.',
    )
  })

  it('keeps direct mode when capability probing fails', async () => {
    const harness = createHarness({
      processing: { format: 'mp4', mp4Mode: 'direct' },
    })
    harness.probeDirectMp4.mockImplementation(async (_path, options) => {
      options?.onProbeFailure?.('unsupported muxer')
      return false
    })
    await harness.runtime.ensureReady()

    expect(harness.runtime.shouldTranscode('mp4')).toBe(false)
    expect(harness.scheduler.acquire).toHaveBeenCalledOnce()
    expect(harness.scheduler.release).toHaveBeenCalledOnce()
    expect(harness.log).toHaveBeenCalledWith(
      'debug',
      '[WdioPuppeteerVideoService] Direct MP4 probe failed: unsupported muxer',
    )
    expect(harness.log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('MP4 strategy is `direct`'),
    )
  })

  it('uses direct MP4 when the capability probe succeeds', async () => {
    const harness = createHarness({ processing: { format: 'mp4' } })
    await harness.runtime.ensureReady()

    expect(harness.runtime.shouldTranscode('mp4')).toBe(false)
    expect(harness.log).toHaveBeenCalledWith(
      'info',
      '[WdioPuppeteerVideoService] Detected ffmpeg support for direct MP4 recording.',
    )
  })

  it('falls back to transcode when auto-mode probing or slot acquisition fails', async () => {
    const failedProbe = createHarness({ processing: { format: 'mp4' } })
    failedProbe.probeDirectMp4.mockResolvedValue(false)
    await failedProbe.runtime.ensureReady()
    expect(failedProbe.runtime.shouldTranscode('mp4')).toBe(true)

    const noCapacity = createHarness({
      processing: { format: 'mp4' },
      concurrency: { postProcessStartTimeoutMs: 456 },
    })
    noCapacity.scheduler.acquire.mockResolvedValue(false)
    await noCapacity.runtime.ensureReady()
    expect(noCapacity.runtime.shouldTranscode('mp4')).toBe(true)
    expect(noCapacity.probeDirectMp4).not.toHaveBeenCalled()
    expect(noCapacity.log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('within 456ms'),
    )
  })

  it('releases post-processing capacity after success and failure', async () => {
    const harness = createHarness()
    const task = vi.fn(async () => 'done')
    await expect(
      harness.runtime.withPostProcessSlot('transcode', task),
    ).resolves.toBe('done')
    expect(harness.scheduler.release).toHaveBeenCalledOnce()

    await expect(
      harness.runtime.withPostProcessSlot('merge', async () => {
        throw new Error('merge failed')
      }),
    ).rejects.toThrow('merge failed')
    expect(harness.scheduler.release).toHaveBeenCalledTimes(2)
  })

  it.each(['transcode', 'merge', 'direct MP4 capability probe'])(
    'reports operational acquisition failure for %s without starting work or reporting contention',
    async (operation) => {
      const harness = createHarness()
      const failure = Object.assign(new Error('lease directory denied'), {
        code: 'EACCES',
      })
      harness.scheduler.acquire.mockRejectedValue(failure)
      const task = vi.fn(async () => 'unexpected work')

      await expect(
        harness.runtime.withPostProcessSlot(operation, task),
      ).resolves.toBeUndefined()
      expect(harness.scheduler.acquire).toHaveBeenCalledOnce()
      expect(task).not.toHaveBeenCalled()
      expect(harness.scheduler.release).not.toHaveBeenCalled()
      expect(harness.log).toHaveBeenCalledExactlyOnceWith(
        'warn',
        `[WdioPuppeteerVideoService] Failed to acquire post-processing capacity for ${operation}:`,
        failure,
      )
    },
  )

  it('creates an independently owned scheduler for every concurrent operation', async () => {
    const harness = createHarness()
    const firstScheduler = createScheduler()
    const secondScheduler = createScheduler()
    harness.createPostProcessSlotScheduler
      .mockReturnValueOnce(
        firstScheduler as unknown as PostProcessSlotScheduler,
      )
      .mockReturnValueOnce(
        secondScheduler as unknown as PostProcessSlotScheduler,
      )
    const firstGate = createDeferred<void>()
    const secondGate = createDeferred<void>()

    const first = harness.runtime.withPostProcessSlot('first', async () => {
      await firstGate.promise
      return 'first'
    })
    const second = harness.runtime.withPostProcessSlot('second', async () => {
      await secondGate.promise
      return 'second'
    })
    await vi.waitFor(() => {
      expect(firstScheduler.acquire).toHaveBeenCalledOnce()
      expect(secondScheduler.acquire).toHaveBeenCalledOnce()
    })
    firstGate.resolve()
    secondGate.resolve()

    await expect(Promise.all([first, second])).resolves.toEqual([
      'first',
      'second',
    ])
    expect(firstScheduler.release).toHaveBeenCalledOnce()
    expect(secondScheduler.release).toHaveBeenCalledOnce()
  })

  it('terminates registered processes and releases every held operation slot', async () => {
    const harness = createHarness()
    const terminate = vi.fn()
    harness.processRegistry.register({ terminate })

    const taskGate = createDeferred<void>()
    const runningTask = harness.runtime.withPostProcessSlot(
      'held operation',
      async () => {
        await taskGate.promise
      },
    )
    await vi.waitFor(() => {
      expect(harness.scheduler.acquire).toHaveBeenCalledOnce()
    })

    await harness.runtime.terminateAll()
    expect(terminate).toHaveBeenCalledOnce()

    await harness.runtime.releaseHeldPostProcessSlots()
    expect(harness.scheduler.release).toHaveBeenCalledOnce()
    taskGate.resolve()
    await runningTask
    expect(harness.scheduler.release).toHaveBeenCalledOnce()
  })

  it('rejects work that arrives during teardown and releases a late slot', async () => {
    const harness = createHarness()
    await harness.runtime.ensureReady()
    let finishAcquire: ((acquired: boolean) => void) | undefined
    harness.scheduler.acquire.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishAcquire = resolve
      }),
    )
    const lateTask = vi.fn(async () => 'late-result')
    const waitingForSlot = harness.runtime.withPostProcessSlot(
      'late transcode',
      lateTask,
    )

    await harness.runtime.terminateAll()
    await expect(harness.runtime.ensureReady()).resolves.toBe(false)
    await expect(harness.runtime.run(['-version'], 'late probe')).resolves.toBe(
      false,
    )
    await expect(
      harness.runtime.withPostProcessSlot('rejected merge', lateTask),
    ).resolves.toBeUndefined()
    expect(harness.runFfmpeg).not.toHaveBeenCalled()

    finishAcquire?.(true)
    await expect(waitingForSlot).resolves.toBeUndefined()
    expect(lateTask).not.toHaveBeenCalled()
    expect(harness.scheduler.release).toHaveBeenCalledOnce()

    harness.runtime.resumeAfterTeardown()
    await expect(
      harness.runtime.run(['-version'], 'resumed probe'),
    ).resolves.toBe(true)
    expect(harness.runFfmpeg).toHaveBeenCalledOnce()
  })
})
