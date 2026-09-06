import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nodeFileSystem } from '../../src/service/boundaries.js'
import { CaptureSession } from '../../src/service/capture-session.js'
import { FfmpegRuntime } from '../../src/service/ffmpeg-runtime.js'
import { assignLauncherWorkerContext } from '../../src/service/launcher-context.js'
import {
  assignManifestRunContext,
  assignManifestWorkerContext,
  ManifestWorkerRecorder,
} from '../../src/service/manifest-runtime.js'
import { PuppeteerCaptureEngine } from '../../src/service/puppeteer-capture-engine.js'
import { RecordingController } from '../../src/service/recording-controller.js'
import { RecordingMediaCoordinator } from '../../src/service/recording-media-coordinator.js'
import type { WorkerRecordingCoordinatorPort } from '../../src/service/worker-recording-coordinator.js'
import { WdioPuppeteerVideoWorkerRuntime } from '../../src/service/worker-runtime.js'

// Observe public component boundaries; the worker's hook sequencing stays real.
const createHarness = () => {
  const events: string[] = []
  const terminate = vi
    .spyOn(FfmpegRuntime.prototype, 'terminateAll')
    .mockImplementation(async () => {
      events.push('terminate')
    })
  const resume = vi
    .spyOn(FfmpegRuntime.prototype, 'resumeAfterTeardown')
    .mockImplementation(() => {
      events.push('resume')
    })
  const release = vi
    .spyOn(FfmpegRuntime.prototype, 'releaseHeldPostProcessSlots')
    .mockImplementation(async () => {
      events.push('release')
    })
  const stop = vi
    .spyOn(RecordingController.prototype, 'stopRecording')
    .mockImplementation(async () => {
      events.push('stop')
    })
  const reset = vi
    .spyOn(RecordingController.prototype, 'reset')
    .mockImplementation(async () => {
      events.push('reset')
    })
  const flushMedia = vi
    .spyOn(RecordingMediaCoordinator.prototype, 'flush')
    .mockImplementation(async () => {
      events.push('media')
    })
  const flushManifest = vi
    .spyOn(ManifestWorkerRecorder.prototype, 'flush')
    .mockImplementation(async () => {
      events.push('manifest')
    })
  const active = vi
    .spyOn(CaptureSession.prototype, 'isRecordingActive', 'get')
    .mockReturnValue(false)
  const slug = vi
    .spyOn(CaptureSession.prototype, 'currentTestSlug', 'get')
    .mockReturnValue('')
  const ownsResources = vi
    .spyOn(RecordingController.prototype, 'ownsResources', 'get')
    .mockReturnValue(false)
  const coordinator: WorkerRecordingCoordinatorPort = {
    framework: 'mocha',
    isSpecScope: false,
    beginEntity: vi.fn(async () => {}),
    beginWorker: vi.fn(),
    configureSession: vi.fn(),
    endEntity: vi.fn(async () => {}),
    finalizeSpecRecording: vi.fn(async () => {
      events.push('spec')
    }),
    resetWorkerState: vi.fn(() => {
      events.push('worker')
    }),
  }
  const writeLog = vi.fn()
  const worker = new WdioPuppeteerVideoWorkerRuntime(
    { failurePolicy: 'error', logLevel: 'trace' },
    undefined,
    undefined,
    {
      createRecordingCoordinator: () => coordinator,
      fileSystem: { ...nodeFileSystem, mkdir: vi.fn(async () => {}) },
      writeLog,
    },
  )
  return {
    worker,
    coordinator,
    events,
    terminate,
    resume,
    release,
    stop,
    reset,
    flushMedia,
    flushManifest,
    active,
    slug,
    ownsResources,
    writeLog,
  }
}

const initializeWorker = async (worker: WdioPuppeteerVideoWorkerRuntime) => {
  const config = { framework: 'mocha' }
  assignLauncherWorkerContext(config, true, 'worker-sequencing')
  assignManifestRunContext(config, {
    runId: 'worker-sequencing',
    outputDir: path.resolve('tests/results/worker-sequencing'),
    startedAt: '2026-09-05T00:00:00.000Z',
    tools: {
      service: '1.0.0-rc.1',
      node: process.version,
      webdriverio: '9.31.5',
      puppeteer: '24.43.1',
    },
  })
  assignManifestWorkerContext(config, '0-0', { specFileRetryAttempt: 0 })
  const capabilities = { browserName: 'chrome', browserVersion: '152' }
  await worker.beforeSession(config, capabilities, ['example.spec.ts'], '0-0')
  await worker.before(capabilities, ['example.spec.ts'], {
    sessionId: 'old-session',
    capabilities,
    isMultiremote: false,
  } as Parameters<WdioPuppeteerVideoWorkerRuntime['before']>[2])
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('worker runtime hook sequencing', () => {
  it('drains media before manifest flush and clears browser state after repeated hooks', async () => {
    const harness = createHarness()
    await initializeWorker(harness.worker)
    const beforeWindow = vi
      .spyOn(RecordingController.prototype, 'beforeWindowCommand')
      .mockResolvedValue(undefined)
    const afterWindow = vi
      .spyOn(RecordingController.prototype, 'afterWindowCommand')
      .mockResolvedValue(undefined)
    await harness.worker.beforeCommand('closeWindow')
    await harness.worker.afterCommand('switchToWindow')
    expect(beforeWindow).toHaveBeenCalledOnce()
    expect(afterWindow).toHaveBeenCalledOnce()

    await harness.worker.after()
    await harness.worker.afterSession()
    await harness.worker.afterSession()

    expect(harness.events).toEqual([
      'terminate',
      'resume',
      'media',
      'worker',
      'terminate',
      'release',
      'terminate',
      'resume',
      'media',
      'worker',
      'terminate',
      'release',
      'manifest',
      'terminate',
      'resume',
      'media',
      'worker',
      'terminate',
      'release',
      'manifest',
    ])
    await harness.worker.beforeCommand('closeWindow')
    await harness.worker.afterCommand('switchToWindow')
    expect(beforeWindow).toHaveBeenCalledOnce()
    expect(afterWindow).toHaveBeenCalledOnce()
  })

  it.each([
    { specScope: false, slug: 'test', expected: ['stop', 'reset'] },
    { specScope: true, slug: 'spec', expected: ['spec'] },
    { specScope: true, slug: '', expected: ['stop', 'reset'] },
  ])(
    'finalizes active capture for scope=$specScope slug=$slug',
    async ({ specScope, slug, expected }) => {
      const harness = createHarness()
      Object.assign(harness.coordinator, { isSpecScope: specScope })
      harness.active.mockReturnValue(true)
      harness.slug.mockReturnValue(slug)

      await harness.worker.after()

      expect(harness.events).toEqual([
        'terminate',
        'resume',
        ...expected,
        'media',
        'worker',
        'terminate',
        'release',
      ])
    },
  )

  it('resets owned capture resources and releases capacity when deferred media fails', async () => {
    const harness = createHarness()
    const failure = new Error('deferred processing failed')
    harness.ownsResources.mockReturnValue(true)
    harness.flushMedia.mockImplementation(async () => {
      harness.events.push('media')
      throw failure
    })

    await expect(harness.worker.after()).rejects.toBe(failure)

    expect(harness.events).toEqual([
      'terminate',
      'resume',
      'media',
      'reset',
      'worker',
      'terminate',
      'release',
    ])
  })

  it.each([false, true])(
    'flushes the manifest and preserves error priority when teardown fails=%s',
    async (teardownFails) => {
      const harness = createHarness()
      await initializeWorker(harness.worker)
      const teardownFailure = new Error('media failure')
      const manifestFailure = new Error('journal failure')
      if (teardownFails) {
        harness.flushMedia.mockRejectedValueOnce(teardownFailure)
      }
      harness.flushManifest.mockRejectedValueOnce(manifestFailure)
      const clearBrowser = vi.spyOn(CaptureSession.prototype, 'clearBrowser')

      await expect(harness.worker.afterSession()).rejects.toBe(
        teardownFails ? teardownFailure : manifestFailure,
      )

      expect(harness.flushManifest).toHaveBeenCalledOnce()
      expect(harness.release).toHaveBeenCalledOnce()
      expect(clearBrowser).toHaveBeenCalledOnce()
      await expect(harness.worker.afterSession()).resolves.toBeUndefined()
    },
  )

  it('awaits pending teardown before resetting a reloaded session', async () => {
    const harness = createHarness()
    await initializeWorker(harness.worker)
    const pendingMedia = Promise.withResolvers<void>()
    const mediaStarted = Promise.withResolvers<void>()
    harness.flushMedia.mockImplementationOnce(async () => {
      harness.events.push('media-start')
      mediaStarted.resolve()
      await pendingMedia.promise
      harness.events.push('media-end')
    })
    const resetConnection = vi.spyOn(
      PuppeteerCaptureEngine.prototype,
      'resetConnection',
    )
    const sessionId = vi.spyOn(RecordingController.prototype, 'setSessionId')
    const manifestSession = vi.spyOn(
      ManifestWorkerRecorder.prototype,
      'configureSession',
    )

    const after = harness.worker.after()
    await mediaStarted.promise
    const reload = harness.worker.onReload('old-session', 'new-session')
    expect(sessionId).not.toHaveBeenCalled()
    expect(resetConnection).not.toHaveBeenCalled()
    pendingMedia.resolve()
    await Promise.all([after, reload])

    expect(harness.events).toEqual([
      'terminate',
      'resume',
      'media-start',
      'media-end',
      'worker',
      'terminate',
      'release',
      'resume',
    ])
    expect(sessionId).toHaveBeenCalledExactlyOnceWith('new-session')
    expect(resetConnection).toHaveBeenCalledOnce()
    expect(manifestSession).toHaveBeenCalledWith({
      sessionId: 'new-session',
      browserName: 'chrome',
      browserVersion: '152',
      protocol: 'unsupported',
    })
    await harness.worker.afterSession()
  })

  it('does not rebind the session when reload teardown fails', async () => {
    const harness = createHarness()
    const failure = new Error('reload teardown failed')
    harness.flushMedia.mockRejectedValueOnce(failure)
    const sessionId = vi.spyOn(RecordingController.prototype, 'setSessionId')

    await expect(harness.worker.onReload('old', 'new')).rejects.toBe(failure)
    expect(sessionId).not.toHaveBeenCalled()
    expect(harness.release).toHaveBeenCalledOnce()
    await expect(harness.worker.afterSession()).resolves.toBeUndefined()
  })

  it('releases held capacity even when final process cleanup fails', async () => {
    const harness = createHarness()
    const failure = new Error('termination cleanup failed')
    harness.terminate
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure)

    await expect(harness.worker.after()).rejects.toBe(failure)
    expect(harness.release).toHaveBeenCalledOnce()
  })

  it('rejects multiremote capture without touching output files or capture commands', async () => {
    const mkdir = vi.fn(async () => {})
    const writeLog = vi.fn()
    const beforeWindow = vi.spyOn(
      RecordingController.prototype,
      'beforeWindowCommand',
    )
    const worker = new WdioPuppeteerVideoWorkerRuntime(
      {},
      undefined,
      undefined,
      {
        fileSystem: { ...nodeFileSystem, mkdir },
        writeLog,
      },
    )
    await worker.before({}, [], {
      sessionId: 'multi',
      capabilities: { browserName: 'chrome' },
      isMultiremote: true,
    } as unknown as Parameters<WdioPuppeteerVideoWorkerRuntime['before']>[2])
    await worker.beforeCommand('closeWindow')
    await worker.afterSession()

    expect(mkdir).not.toHaveBeenCalled()
    expect(beforeWindow).not.toHaveBeenCalled()
    expect(writeLog).toHaveBeenCalledWith(
      'warn',
      'warn',
      expect.stringContaining('multiremote sessions are not supported'),
      undefined,
    )
  })
})
