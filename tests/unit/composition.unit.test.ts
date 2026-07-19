import type {
  Page,
  Browser as PuppeteerBrowser,
  ScreenRecorder,
} from 'puppeteer-core'
import { describe, expect, it, vi } from 'vitest'
import {
  nodeFileSystem,
  nodeProcess,
  systemClock,
} from '../../src/service/boundaries.js'
import {
  createLauncherCompositionRoot,
  createWorkerCompositionRoot,
} from '../../src/service/composition.js'
import { resolveServiceConfiguration } from '../../src/service/options.js'

describe('launcher and worker composition roots', () => {
  it('composes immutable launcher dependencies with narrow overrides', () => {
    const createManifestRunContext = vi.fn()
    const aggregateManifestRun = vi.fn()
    const generateVideoReportForRun = vi.fn()
    const writeLog = vi.fn()
    const root = createLauncherCompositionRoot({
      createManifestRunContext: createManifestRunContext as never,
      aggregateManifestRun: aggregateManifestRun as never,
      generateVideoReportForRun: generateVideoReportForRun as never,
      writeLog,
    })

    expect(Object.isFrozen(root)).toBe(true)
    expect(root.createManifestRunContext).toBe(createManifestRunContext)
    expect(root.aggregateManifestRun).toBe(aggregateManifestRun)
    expect(root.generateVideoReportForRun).toBe(generateVideoReportForRun)
    expect(root.writeLog).toBe(writeLog)
  })

  it('composes explicit worker boundaries and grouped component options', async () => {
    const clock = { ...systemClock }
    const fileSystem = { ...nodeFileSystem }
    const processBoundary = { ...nodeProcess }
    const uuid = vi.fn(() => 'fixed-uuid')
    const puppeteerBrowser = { connected: true } as PuppeteerBrowser
    const connectPuppeteer = vi.fn(async () => puppeteerBrowser)
    const recorder = { destroyed: false } as ScreenRecorder
    const startScreencast = vi.fn(async () => recorder)
    const runFfmpeg = vi.fn(async () => true)
    const writeLog = vi.fn()
    const root = createWorkerCompositionRoot({
      clock,
      fileSystem,
      process: processBoundary,
      uuid,
      connectPuppeteer,
      startScreencast,
      runFfmpeg,
      writeLog,
    })
    const options = resolveServiceConfiguration({
      concurrency: {
        startMode: 'fast-fail',
        startTimeoutMs: 123,
        postProcessStartMode: 'fast-fail',
        postProcessStartTimeoutMs: 456,
        lockDir: 'locks',
      },
      integrations: { allure: {} },
    }).options

    expect(Object.isFrozen(root)).toBe(true)
    expect(root.clock).toBe(clock)
    expect(root.fileSystem).toBe(fileSystem)
    expect(root.process).toBe(processBoundary)
    expect(root.uuid()).toBe('fixed-uuid')
    expect(root.writeLog).toBe(writeLog)
    await expect(root.connectPuppeteer({} as never, 100)).resolves.toBe(
      puppeteerBrowser,
    )
    await expect(root.startScreencast({} as Page, {} as never)).resolves.toBe(
      recorder,
    )
    await expect(
      root.runFfmpeg({} as never, root.createFfmpegProcessRegistry()),
    ).resolves.toBe(true)
    expect(root.createFfmpegProcessRegistry().size).toBe(0)
    expect(
      root.createRecordingSlotScheduler(options, vi.fn()).startTimeoutMs,
    ).toBe(123)
    expect(
      root.createPostProcessSlotScheduler(options, vi.fn()).ownsPostProcessSlot,
    ).toBe(false)
    expect(root.createAllureIntegration(undefined, vi.fn())).toBeUndefined()
    expect(
      root.createAllureIntegration(options.integrations.allure, vi.fn()),
    ).toBeDefined()
  })

  it('binds default FFmpeg execution to the worker clock', async () => {
    const root = createWorkerCompositionRoot()
    const warnMissing = vi.fn()

    await expect(
      root.runFfmpeg(
        {
          args: [],
          available: false,
          ffmpegPath: 'ffmpeg',
          log: vi.fn(),
          markUnavailable: vi.fn(),
          operation: 'probe',
          timeoutMs: 0,
          warnMissing,
        },
        root.createFfmpegProcessRegistry(),
      ),
    ).resolves.toBe(false)
    expect(warnMissing).toHaveBeenCalledOnce()

    const launcherRoot = createLauncherCompositionRoot()
    expect(launcherRoot.createManifestRunContext).toBeTypeOf('function')
    expect(launcherRoot.aggregateManifestRun).toBeTypeOf('function')
    expect(launcherRoot.generateVideoReportForRun).toBeTypeOf('function')
    expect(launcherRoot.writeLog).toBeTypeOf('function')
  })
})
