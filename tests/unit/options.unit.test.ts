import { describe, expect, it } from 'vitest'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import type { WdioPuppeteerVideoServiceOptions } from '../../src/types.js'

describe('service option resolution', () => {
  it('resolves the canonical grouped defaults', () => {
    const resolved = resolveServiceConfiguration({}, 'linux')

    expect(resolved.options).toMatchObject({
      outputDir: 'videos',
      recordingRetain: 'failures',
      captureViewport: 'current',
      fps: 30,
      captureQuality: 30,
      captureScale: 1,
      captureSpeed: 1,
      framePriming: true,
      puppeteerConnectionTimeoutMs: 10_000,
      recordOnRetries: false,
      specLevelRecording: false,
      segmentOnWindowSwitch: true,
      maxConcurrentRecordings: 0,
      maxGlobalRecordings: 0,
      recordingStartMode: 'blocking',
      recordingStartTimeoutMs: 2500,
      maxConcurrentPostProcesses: 0,
      maxGlobalPostProcesses: 0,
      postProcessStartMode: 'blocking',
      postProcessStartTimeoutMs: 2500,
      ffmpegTimeoutMs: 0,
      postProcessMode: 'immediate',
      outputFormat: 'webm',
      mp4Mode: 'auto',
      fileNameStyle: 'test',
      fileNameOverflowStrategy: 'truncate',
      maxFileNameLength: 255,
      failurePolicy: 'warn',
    })
    expect(resolved.hasExplicitLogLevel).toBe(false)
    expect(resolved.logLevel).toBe('warn')
  })

  it('uses the Windows filename default through the process boundary', () => {
    const resolved = resolveServiceConfiguration({}, 'win32')

    expect(resolved.options.maxFileNameLength).toBe(180)
    expect(resolved.maxSlugLength).toBeLessThan(180)
  })

  it('applies parallel profile defaults and explicit grouped overrides', () => {
    expect(
      resolveServiceConfiguration({ profile: 'parallel' }).options,
    ).toMatchObject({
      fps: 24,
      mergeSegments: { deleteSegments: true, enabled: false },
      outputFormat: 'webm',
    })
    expect(
      resolveServiceConfiguration({
        profile: 'parallel',
        capture: { fps: 48 },
        processing: {
          format: 'mp4',
          merge: { enabled: true },
        },
      }).options,
    ).toMatchObject({
      fps: 48,
      mergeSegments: { deleteSegments: true, enabled: true },
      outputFormat: 'mp4',
    })
  })

  it('resolves Allure defaults without loading the optional peer', () => {
    expect(
      resolveServiceConfiguration({ integrations: { allure: {} } }).options
        .allure,
    ).toEqual({ attach: 'failures' })
    expect(
      resolveServiceConfiguration({
        integrations: {
          allure: { attach: 'retained', maxBytes: 42 },
        },
      }).options.allure,
    ).toEqual({ attach: 'retained', maxBytes: 42 })
  })

  it('applies CI defaults, pinned logging, and explicit grouped overrides', () => {
    const defaults = resolveServiceConfiguration({ profile: 'ci' })
    expect(defaults.options).toMatchObject({
      fps: 24,
      mergeSegments: { deleteSegments: true, enabled: false },
      postProcessMode: 'deferred',
      recordingStartMode: 'fastFail',
      maxGlobalPostProcesses: 1,
      segmentOnWindowSwitch: false,
      framePriming: false,
    })
    expect(defaults.hasExplicitLogLevel).toBe(true)
    expect(defaults.logLevel).toBe('warn')

    const explicit = resolveServiceConfiguration({
      profile: 'ci',
      capture: { fps: 60, framePriming: true },
      concurrency: { startMode: 'blocking' },
      logLevel: 'trace',
      processing: {
        merge: { enabled: true },
        timing: 'after-test',
      },
      recording: { windowChanges: 'segment' },
    })
    expect(explicit.options).toMatchObject({
      fps: 60,
      mergeSegments: { deleteSegments: true, enabled: true },
      postProcessMode: 'immediate',
      recordingStartMode: 'blocking',
      segmentOnWindowSwitch: true,
      framePriming: true,
    })
    expect(explicit.logLevel).toBe('trace')
  })

  it('maps the documented 0.8 migration example to the existing runtime behavior', () => {
    const resolved = resolveServiceConfiguration({
      outputDir: 'artifacts/videos',
      recording: {
        scope: 'spec',
        attempts: 'retries',
        retain: 'retries',
        windowChanges: 'ignore',
        filters: {
          includeSpecs: [' *Critical* ', '*critical*'],
          excludeTags: [' @noVideo '],
        },
      },
      capture: {
        viewport: { width: 1440, height: 900 },
        fps: 24,
        quality: 20,
        scale: 0.5,
        speed: 2,
        crop: { x: 10, y: 20, width: 1200, height: 800 },
        framePriming: false,
        connectionTimeoutMs: 1500,
      },
      processing: {
        format: 'mp4',
        mp4Mode: 'transcode',
        timing: 'after-worker',
        ffmpeg: { path: ' C:/tools/ffmpeg.exe ', timeoutMs: 5000 },
        transcode: { enabled: true },
        merge: { enabled: true, deleteSegments: false },
      },
      concurrency: {
        maxRecordingsPerProcess: 2,
        maxRecordingsGlobal: 4,
        startMode: 'fast-fail',
        startTimeoutMs: 1200,
        maxPostProcessesPerProcess: 3,
        maxPostProcessesGlobal: 2,
        postProcessStartMode: 'fast-fail',
        postProcessStartTimeoutMs: 900,
        lockDir: ' .locks ',
      },
      artifacts: {
        naming: {
          style: 'test-full',
          maxLength: 160,
          overflow: 'session',
        },
      },
      failurePolicy: 'error',
    })

    expect(resolved.options).toMatchObject({
      outputDir: 'artifacts/videos',
      recordingRetain: 'retries',
      recordOnRetries: true,
      specLevelRecording: true,
      segmentOnWindowSwitch: false,
      includeSpecPatterns: ['*critical*'],
      excludeTagPatterns: ['@novideo'],
      captureViewport: { width: 1440, height: 900 },
      fps: 24,
      captureQuality: 20,
      captureScale: 0.5,
      captureSpeed: 2,
      captureCrop: { x: 10, y: 20, width: 1200, height: 800 },
      framePriming: false,
      puppeteerConnectionTimeoutMs: 1500,
      outputFormat: 'mp4',
      mp4Mode: 'transcode',
      postProcessMode: 'deferred',
      ffmpegPath: 'C:/tools/ffmpeg.exe',
      ffmpegTimeoutMs: 5000,
      maxConcurrentRecordings: 2,
      maxGlobalRecordings: 4,
      recordingStartMode: 'fastFail',
      recordingStartTimeoutMs: 1200,
      maxConcurrentPostProcesses: 3,
      maxGlobalPostProcesses: 2,
      postProcessStartMode: 'fastFail',
      postProcessStartTimeoutMs: 900,
      globalRecordingLockDir: '.locks',
      fileNameStyle: 'testFull',
      maxFileNameLength: 160,
      fileNameOverflowStrategy: 'session',
      failurePolicy: 'error',
    })
  })

  it('rejects a removed beta option with a migration-specific message', () => {
    const betaOptions = {
      saveAllVideos: true,
    } as unknown as WdioPuppeteerVideoServiceOptions

    expect(() =>
      resolveServiceConfiguration(betaOptions),
    ).toThrowErrorMatchingInlineSnapshot(
      `[TypeError: [WdioPuppeteerVideoService] Configuration option "saveAllVideos" was removed in 1.0. Use "recording.retain: 'all'" instead. Deprecated 0.8 aliases are not accepted.]`,
    )
  })

  it.each([
    'saveAllVideos',
    'videoWidth',
    'videoHeight',
    'fps',
    'recordOnRetries',
    'specLevelRecording',
    'skipViewPortKickoff',
    'segmentOnWindowSwitch',
    'maxConcurrentRecordings',
    'maxGlobalRecordings',
    'recordingStartMode',
    'recordingStartTimeoutMs',
    'globalRecordingLockDir',
    'postProcessMode',
    'includeSpecPatterns',
    'excludeSpecPatterns',
    'includeTagPatterns',
    'excludeTagPatterns',
    'performanceProfile',
    'maxFileNameLength',
    'fileNameOverflowStrategy',
    'fileNameStyle',
    'ffmpegPath',
    'ffmpegTimeoutMs',
    'outputFormat',
    'mp4Mode',
    'transcode',
    'mergeSegments',
  ])('provides migration guidance for removed 0.8 key %s', (key) => {
    const betaOptions = { [key]: true } as WdioPuppeteerVideoServiceOptions

    expect(() => resolveServiceConfiguration(betaOptions)).toThrow(
      'Deprecated 0.8 aliases are not accepted',
    )
  })

  it('rejects unknown nested options with a stable configuration snapshot', () => {
    const invalidOptions = {
      recording: { unknown: true },
    } as unknown as WdioPuppeteerVideoServiceOptions

    expect(() =>
      resolveServiceConfiguration(invalidOptions),
    ).toThrowErrorMatchingInlineSnapshot(
      `[TypeError: [WdioPuppeteerVideoService] Unknown configuration option "recording.unknown". Supported options in "recording": scope, attempts, retain, windowChanges, filters.]`,
    )
  })

  it.each([
    [{ capture: { fps: 0 } }, 'capture.fps'],
    [{ capture: { viewport: { width: 1280 } } }, 'capture.viewport.height'],
    [{ capture: { quality: 64 } }, 'capture.quality'],
    [{ capture: { scale: 0 } }, 'capture.scale'],
    [{ capture: { speed: Number.NaN } }, 'capture.speed'],
    [
      { capture: { crop: { x: -1, y: 0, width: 1, height: 1 } } },
      'capture.crop.x',
    ],
    [{ capture: { connectionTimeoutMs: 0 } }, 'capture.connectionTimeoutMs'],
    [
      { concurrency: { maxRecordingsGlobal: 1.5 } },
      'concurrency.maxRecordingsGlobal',
    ],
    [
      { concurrency: { maxPostProcessesPerProcess: -1 } },
      'concurrency.maxPostProcessesPerProcess',
    ],
    [
      { concurrency: { postProcessStartMode: 'skip' } },
      'concurrency.postProcessStartMode',
    ],
    [{ processing: { timing: 'deferred' } }, 'processing.timing'],
    [
      { integrations: { allure: { attach: 'all' } } },
      'integrations.allure.attach',
    ],
    [
      { integrations: { allure: { maxBytes: 0 } } },
      'integrations.allure.maxBytes',
    ],
  ])('rejects invalid runtime configuration %#', (value, expectedPath) => {
    expect(() =>
      resolveServiceConfiguration(
        value as unknown as WdioPuppeteerVideoServiceOptions,
      ),
    ).toThrow(expectedPath)
  })

  it.each([
    [
      { integrations: { allure: {} }, recording: { scope: 'spec' } },
      'recording.scope to be "test"',
    ],
    [
      {
        integrations: { allure: {} },
        processing: { timing: 'after-worker' },
      },
      'processing.timing to be "after-test"',
    ],
    [
      { integrations: { allure: {} }, profile: 'ci' },
      'processing.timing to be "after-test"',
    ],
  ])('rejects incompatible Allure configuration %#', (value, message) => {
    expect(() =>
      resolveServiceConfiguration(value as WdioPuppeteerVideoServiceOptions),
    ).toThrow(message)
  })
})
