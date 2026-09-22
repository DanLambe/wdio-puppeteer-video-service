import { describe, expect, it } from 'vitest'
import { CI_TRANSCODE_FFMPEG_ARGS } from '../../src/service/constants.js'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import type { WdioPuppeteerVideoServiceOptions } from '../../src/types.js'

describe('service option resolution', () => {
  it('resolves the canonical grouped defaults', () => {
    const resolved = resolveServiceConfiguration({}, 'linux')

    expect(resolved.options).toMatchObject({
      outputDir: 'videos',
      recording: {
        scope: 'test',
        attempts: 'all',
        retain: 'failures',
        windowChanges: 'segment',
        filters: {
          includeSpecs: [],
          excludeSpecs: [],
          includeTags: [],
          excludeTags: [],
        },
      },
      capture: {
        viewport: 'current',
        fps: 30,
        quality: 30,
        scale: 1,
        speed: 1,
        framePriming: true,
        connectionTimeoutMs: 10_000,
      },
      processing: {
        format: 'webm',
        mp4Mode: 'auto',
        timing: 'after-test',
        ffmpeg: { timeoutMs: 0 },
        transcode: { enabled: false, deleteOriginal: true },
        merge: { enabled: false, deleteSegments: true },
      },
      concurrency: {
        maxRecordingsPerProcess: 0,
        maxRecordingsGlobal: 0,
        startMode: 'blocking',
        startTimeoutMs: 2500,
        maxPostProcessesPerProcess: 1,
        maxPostProcessesGlobal: 0,
        postProcessStartMode: 'blocking',
        postProcessStartTimeoutMs: 2500,
      },
      artifacts: {
        naming: { style: 'test', overflow: 'truncate', maxLength: 255 },
      },
      integrations: {},
      profile: 'default',
      logLevel: 'warn',
      failurePolicy: 'warn',
    })
    expect(resolved.hasExplicitLogLevel).toBe(false)
    expect(resolved.logLevel).toBe('warn')
  })

  it('uses the Windows filename default through the process boundary', () => {
    const resolved = resolveServiceConfiguration({}, 'win32')

    expect(resolved.options.artifacts.naming.maxLength).toBe(180)
    expect(resolved.maxSlugLength).toBeLessThan(180)
  })

  it('applies parallel profile defaults and explicit grouped overrides', () => {
    expect(
      resolveServiceConfiguration({ profile: 'parallel' }).options,
    ).toMatchObject({
      capture: { fps: 24 },
      concurrency: { maxPostProcessesPerProcess: 1 },
      processing: {
        merge: { deleteSegments: true, enabled: false },
        format: 'webm',
      },
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
      capture: { fps: 48 },
      processing: {
        merge: { deleteSegments: true, enabled: true },
        format: 'mp4',
      },
    })
  })

  it('resolves Allure defaults without loading the optional peer', () => {
    expect(
      resolveServiceConfiguration({ integrations: { allure: {} } }).options
        .integrations.allure,
    ).toEqual({ attach: 'failures' })
    expect(
      resolveServiceConfiguration({
        integrations: {
          allure: { attach: 'retained', maxBytes: 42 },
        },
      }).options.integrations.allure,
    ).toEqual({ attach: 'retained', maxBytes: 42 })
  })

  it('keeps the CI transcode at a smaller, lower quality CRF', () => {
    // The fast preset is a near free speed win and applies everywhere. Dropping
    // to CRF 28 costs measurable fidelity for about 2% more speed, so only the
    // CI profile opts into it, and it is appended after the default so it wins.
    const args =
      resolveServiceConfiguration({ profile: 'ci' }).options.processing
        .transcode.ffmpegArgs ?? []
    expect(args).toContain('28')
    expect(args.indexOf('-crf')).toBeGreaterThanOrEqual(0)
    expect(args).toEqual([...CI_TRANSCODE_FFMPEG_ARGS])
  })

  it('rejects a capture bound combined with a crop', () => {
    // Chrome applies the bound against the viewport of each frame, so a crop
    // rectangle scaled at capture start selects the wrong region as soon as the
    // viewport changes - including the restore `capture.viewport` performs.
    // Publishing a healthy recording of a different region is worse than
    // refusing the combination.
    for (const bound of [{ maxWidth: 640 }, { maxHeight: 480 }]) {
      expect(() =>
        resolveServiceConfiguration({
          capture: { crop: { x: 0, y: 0, width: 100, height: 100 }, ...bound },
        }),
      ).toThrow(/cannot be combined with/u)
    }
  })

  it('does not let the CI profile add a bound behind a cropped recording', () => {
    // The profile default must not create the rejected combination by itself.
    const capture = resolveServiceConfiguration({
      profile: 'ci',
      capture: { crop: { x: 0, y: 0, width: 100, height: 100 } },
    }).options.capture
    expect(capture.maxWidth).toBeUndefined()
    expect(capture.maxHeight).toBeUndefined()
    expect(capture.crop).toEqual({ x: 0, y: 0, width: 100, height: 100 })
  })

  it('caps capture width on CI and leaves other profiles at native size', () => {
    // Encoding cost scales with pixels, and CI runners are the least able to
    // absorb it, so `ci` opts into a bound the other profiles do not.
    expect(
      resolveServiceConfiguration({ profile: 'ci' }).options.capture.maxWidth,
    ).toBe(1280)
    for (const profile of ['default', 'parallel'] as const) {
      const capture = resolveServiceConfiguration({ profile }).options.capture
      expect(capture.maxWidth).toBeUndefined()
      expect(capture.maxHeight).toBeUndefined()
    }
  })

  it('lets an explicit capture bound replace the CI default entirely', () => {
    expect(
      resolveServiceConfiguration({ profile: 'ci', capture: { maxWidth: 640 } })
        .options.capture,
    ).toMatchObject({ maxWidth: 640 })

    // A height-only bound is a deliberate choice, so the profile must not
    // quietly reimpose its width alongside it.
    const heightOnly = resolveServiceConfiguration({
      profile: 'ci',
      capture: { maxHeight: 480 },
    }).options.capture
    expect(heightOnly.maxHeight).toBe(480)
    expect(heightOnly.maxWidth).toBeUndefined()
  })

  it('applies CI defaults, pinned logging, and explicit grouped overrides', () => {
    const defaults = resolveServiceConfiguration({ profile: 'ci' })
    expect(defaults.options).toMatchObject({
      capture: { fps: 24, framePriming: false, maxWidth: 1280 },
      processing: {
        merge: { deleteSegments: true, enabled: false },
        timing: 'after-worker',
        transcode: {
          ffmpegArgs: [...CI_TRANSCODE_FFMPEG_ARGS],
        },
      },
      concurrency: {
        maxPostProcessesPerProcess: 1,
        startMode: 'fast-fail',
        maxPostProcessesGlobal: 1,
      },
      recording: { windowChanges: 'ignore' },
    })
    expect(defaults.hasExplicitLogLevel).toBe(true)
    expect(defaults.logLevel).toBe('warn')

    const explicit = resolveServiceConfiguration({
      profile: 'ci',
      capture: { fps: 60, framePriming: true },
      concurrency: {
        maxPostProcessesPerProcess: 3,
        startMode: 'blocking',
      },
      logLevel: 'trace',
      processing: {
        merge: { enabled: true },
        timing: 'after-test',
      },
      recording: { windowChanges: 'segment' },
    })
    expect(explicit.options).toMatchObject({
      capture: { fps: 60, framePriming: true },
      processing: {
        merge: { deleteSegments: true, enabled: true },
        timing: 'after-test',
      },
      concurrency: {
        maxPostProcessesPerProcess: 3,
        startMode: 'blocking',
      },
      recording: { windowChanges: 'segment' },
    })
    expect(explicit.logLevel).toBe('trace')

    expect(
      resolveServiceConfiguration({
        profile: 'ci',
        processing: { transcode: { ffmpegArgs: [] } },
      }).options.processing.transcode.ffmpegArgs,
    ).toEqual([])
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
      recording: {
        scope: 'spec',
        attempts: 'retries',
        retain: 'retries',
        windowChanges: 'ignore',
        filters: {
          includeSpecs: ['*critical*'],
          excludeTags: ['@novideo'],
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
        ffmpeg: { path: 'C:/tools/ffmpeg.exe', timeoutMs: 5000 },
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
        lockDir: '.locks',
      },
      artifacts: {
        naming: { style: 'test-full', maxLength: 160, overflow: 'session' },
      },
      failurePolicy: 'error',
    })
  })

  it('returns a deeply immutable runtime contract', () => {
    const options = resolveServiceConfiguration({
      recording: { filters: { includeSpecs: ['spec-a'] } },
      processing: { transcode: { ffmpegArgs: ['-crf', '28'] } },
      integrations: { allure: {} },
    }).options

    expect(Object.isFrozen(options)).toBe(true)
    expect(Object.isFrozen(options.recording)).toBe(true)
    expect(Object.isFrozen(options.recording.filters)).toBe(true)
    expect(Object.isFrozen(options.recording.filters.includeSpecs)).toBe(true)
    expect(Object.isFrozen(options.capture)).toBe(true)
    const explicit = resolveServiceConfiguration({
      capture: {
        viewport: { width: 1280, height: 720 },
        crop: { x: 0, y: 0, width: 640, height: 360 },
      },
    }).options
    expect(Object.isFrozen(explicit.capture.viewport)).toBe(true)
    expect(Object.isFrozen(explicit.capture.crop)).toBe(true)
    expect(Object.isFrozen(options.processing)).toBe(true)
    expect(Object.isFrozen(options.processing.transcode.ffmpegArgs)).toBe(true)
    expect(Object.isFrozen(options.concurrency)).toBe(true)
    expect(Object.isFrozen(options.artifacts.naming)).toBe(true)
    expect(Object.isFrozen(options.integrations.allure)).toBe(true)
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
      { concurrency: { maxPostProcessesPerProcess: 0 } },
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
