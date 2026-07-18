import { describe, expect, it } from 'vitest'
import { resolveServiceConfiguration } from '../../src/service/options.js'

describe('service option resolution', () => {
  it('preserves the flat default configuration', () => {
    const resolved = resolveServiceConfiguration({}, 'linux')

    expect(resolved.options).toMatchObject({
      outputDir: 'videos',
      saveAllVideos: false,
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
    })
    expect(resolved.hasExplicitLogLevel).toBe(false)
    expect(resolved.logLevel).toBe('warn')
  })

  it('uses the existing Windows filename default through the process boundary', () => {
    const resolved = resolveServiceConfiguration({}, 'win32')

    expect(resolved.options.maxFileNameLength).toBe(180)
    expect(resolved.maxSlugLength).toBeLessThan(180)
  })

  it('keeps parallel profile defaults and explicit overrides', () => {
    expect(
      resolveServiceConfiguration({ performanceProfile: 'parallel' }).options,
    ).toMatchObject({
      fps: 24,
      mergeSegments: { deleteSegments: true, enabled: false },
      outputFormat: 'webm',
    })
    expect(
      resolveServiceConfiguration({
        performanceProfile: 'parallel',
        fps: 48,
        mergeSegments: { enabled: true },
        outputFormat: 'mp4',
      }).options,
    ).toMatchObject({
      fps: 48,
      mergeSegments: { deleteSegments: true, enabled: true },
      outputFormat: 'mp4',
    })
  })

  it('keeps CI defaults, pinned logging, and explicit overrides', () => {
    const defaults = resolveServiceConfiguration({ performanceProfile: 'ci' })
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
      performanceProfile: 'ci',
      fps: 60,
      logLevel: 'trace',
      mergeSegments: { enabled: true },
      postProcessMode: 'immediate',
      recordingStartMode: 'blocking',
      segmentOnWindowSwitch: true,
      skipViewPortKickoff: false,
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

  it('defensively normalizes invalid runtime values without changing defaults', () => {
    const resolved = resolveServiceConfiguration({
      fps: Number.NaN,
      maxConcurrentRecordings: -1,
      maxGlobalRecordings: 2.9,
      mp4Mode: 'invalid' as never,
      outputDir: '   ',
      recordingStartMode: 'invalid' as never,
    })

    expect(resolved.options).toMatchObject({
      fps: 30,
      maxConcurrentRecordings: 0,
      maxGlobalRecordings: 2,
      mp4Mode: 'auto',
      outputDir: 'videos',
      recordingStartMode: 'blocking',
    })
  })
})
