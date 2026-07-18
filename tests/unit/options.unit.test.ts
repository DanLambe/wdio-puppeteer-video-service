import { describe, expect, it } from 'vitest'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import type { WdioPuppeteerVideoServiceOptions } from '../../src/types.js'

describe('service option resolution', () => {
  it('resolves the canonical grouped defaults', () => {
    const resolved = resolveServiceConfiguration({}, 'linux')

    expect(resolved.options).toMatchObject({
      outputDir: 'videos',
      recordingRetain: 'failures',
      videoWidth: 1280,
      videoHeight: 720,
      fps: 30,
      recordOnRetries: false,
      specLevelRecording: false,
      skipViewPortKickoff: false,
      segmentOnWindowSwitch: true,
      maxConcurrentRecordings: 0,
      maxGlobalRecordings: 0,
      recordingStartMode: 'blocking',
      recordingStartTimeoutMs: 2500,
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

  it('applies CI defaults, pinned logging, and explicit grouped overrides', () => {
    const defaults = resolveServiceConfiguration({ profile: 'ci' })
    expect(defaults.options).toMatchObject({
      fps: 24,
      mergeSegments: { deleteSegments: true, enabled: false },
      postProcessMode: 'deferred',
      recordingStartMode: 'fastFail',
      segmentOnWindowSwitch: false,
      skipViewPortKickoff: true,
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
      skipViewPortKickoff: false,
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
      capture: { width: 1440, height: 900, fps: 24, framePriming: false },
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
      videoWidth: 1440,
      videoHeight: 900,
      fps: 24,
      skipViewPortKickoff: true,
      outputFormat: 'mp4',
      mp4Mode: 'transcode',
      postProcessMode: 'deferred',
      ffmpegPath: 'C:/tools/ffmpeg.exe',
      ffmpegTimeoutMs: 5000,
      maxConcurrentRecordings: 2,
      maxGlobalRecordings: 4,
      recordingStartMode: 'fastFail',
      recordingStartTimeoutMs: 1200,
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
    [
      { concurrency: { maxRecordingsGlobal: 1.5 } },
      'concurrency.maxRecordingsGlobal',
    ],
    [{ processing: { timing: 'deferred' } }, 'processing.timing'],
    [{ integrations: { allure: {} } }, 'integrations.allure'],
  ])('rejects invalid runtime configuration %#', (value, expectedPath) => {
    expect(() =>
      resolveServiceConfiguration(
        value as unknown as WdioPuppeteerVideoServiceOptions,
      ),
    ).toThrow(expectedPath)
  })
})
