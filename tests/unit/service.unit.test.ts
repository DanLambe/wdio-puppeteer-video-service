import path from 'node:path'
import type { Frameworks } from '@wdio/types'
import { describe, expect, it } from 'vitest'
import WdioPuppeteerVideoService from '../../src/service.js'

const createTest = (
  overrides: Partial<Frameworks.Test> = {},
): Frameworks.Test => {
  return {
    type: 'test',
    title: 'default test',
    parent: 'suite',
    fullTitle: 'suite default test',
    pending: false,
    file: 'tests/specs/e2e.test.ts',
    fullName: 'suite default test',
    ctx: {},
    ...overrides,
  }
}

describe('WdioPuppeteerVideoService unit', () => {
  it('constructor applies stable defaults and normalizes invalid numbers', () => {
    const service = new WdioPuppeteerVideoService({
      outputDir: '   ',
      videoWidth: 0,
      videoHeight: -10,
      fps: Number.NaN,
      outputFormat: 'mp4',
    }) as unknown as {
      _options: {
        outputDir: string
        videoWidth: number
        videoHeight: number
        fps: number
        outputFormat?: 'webm' | 'mp4'
        mp4Mode?: string
        maxFileNameLength?: number
        fileNameStyle?: string
        fileNameOverflowStrategy?: string
        performanceProfile?: string
        transcode?: { deleteOriginal?: boolean }
        mergeSegments?: { deleteSegments?: boolean; enabled?: boolean }
      }
      _logLevel: string
    }

    expect(service._options.outputDir).toBe('videos')
    expect(service._options.videoWidth).toBe(1280)
    expect(service._options.videoHeight).toBe(720)
    expect(service._options.fps).toBe(30)
    expect(service._options.maxFileNameLength).toBeGreaterThanOrEqual(40)
    expect(service._options.fileNameStyle).toBe('test')
    expect(service._options.fileNameOverflowStrategy).toBe('truncate')
    expect(service._options.mp4Mode).toBe('auto')
    expect(service._options.performanceProfile).toBe('default')
    expect(service._options.transcode?.deleteOriginal).toBe(true)
    expect(service._options.mergeSegments?.deleteSegments).toBe(true)
    expect(service._logLevel).toBe('warn')
  })

  it('parallel performance profile applies conservative defaults', () => {
    const service = new WdioPuppeteerVideoService({
      performanceProfile: 'parallel',
    }) as unknown as {
      _options: {
        videoWidth: number
        videoHeight: number
        fps: number
        outputFormat?: 'webm' | 'mp4'
        mp4Mode?: string
        performanceProfile?: string
        mergeSegments?: { enabled?: boolean; deleteSegments?: boolean }
      }
    }

    expect(service._options.performanceProfile).toBe('parallel')
    expect(service._options.videoWidth).toBe(1280)
    expect(service._options.videoHeight).toBe(720)
    expect(service._options.fps).toBe(24)
    expect(service._options.outputFormat).toBe('webm')
    expect(service._options.mp4Mode).toBe('auto')
    expect(service._options.mergeSegments?.enabled).toBe(false)
    expect(service._options.mergeSegments?.deleteSegments).toBe(true)
  })

  it('parallel performance profile does not override explicit values', () => {
    const service = new WdioPuppeteerVideoService({
      performanceProfile: 'parallel',
      videoWidth: 1920,
      videoHeight: 1080,
      fps: 30,
      outputFormat: 'mp4',
      mp4Mode: 'direct',
      mergeSegments: {
        enabled: true,
        deleteSegments: false,
      },
    }) as unknown as {
      _options: {
        videoWidth: number
        videoHeight: number
        fps: number
        outputFormat?: 'webm' | 'mp4'
        mp4Mode?: string
        mergeSegments?: { enabled?: boolean; deleteSegments?: boolean }
      }
    }

    expect(service._options.videoWidth).toBe(1920)
    expect(service._options.videoHeight).toBe(1080)
    expect(service._options.fps).toBe(30)
    expect(service._options.outputFormat).toBe('mp4')
    expect(service._options.mp4Mode).toBe('direct')
    expect(service._options.mergeSegments?.enabled).toBe(true)
    expect(service._options.mergeSegments?.deleteSegments).toBe(false)
  })

  it('constructor honors explicit service logLevel', () => {
    const service = new WdioPuppeteerVideoService({
      logLevel: 'silent',
    }) as unknown as {
      _logLevel: string
    }

    expect(service._logLevel).toBe('silent')
  })

  it('normalizeMp4Mode supports known values and falls back to auto', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _normalizeMp4Mode: (mode: string | undefined) => string
    }

    expect(service._normalizeMp4Mode('auto')).toBe('auto')
    expect(service._normalizeMp4Mode('direct')).toBe('direct')
    expect(service._normalizeMp4Mode('transcode')).toBe('transcode')
    expect(service._normalizeMp4Mode('invalid')).toBe('auto')
    expect(service._normalizeMp4Mode(undefined)).toBe('auto')
  })

  it('normalizeFileNameStyle supports known values and falls back to test', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _normalizeFileNameStyle: (mode: string | undefined) => string
    }

    expect(service._normalizeFileNameStyle('test')).toBe('test')
    expect(service._normalizeFileNameStyle('session')).toBe('session')
    expect(service._normalizeFileNameStyle('sessionFull')).toBe('sessionFull')
    expect(service._normalizeFileNameStyle('invalid')).toBe('test')
    expect(service._normalizeFileNameStyle(undefined)).toBe('test')
  })

  it('shouldTranscode respects mp4 mode and transcode override', () => {
    const autoService = new WdioPuppeteerVideoService({
      outputFormat: 'mp4',
      mp4Mode: 'auto',
    }) as unknown as {
      _forceMp4Transcode: boolean
      _shouldTranscode: (outputFormat: 'webm' | 'mp4') => boolean
    }

    autoService._forceMp4Transcode = false
    expect(autoService._shouldTranscode('mp4')).toBe(false)
    autoService._forceMp4Transcode = true
    expect(autoService._shouldTranscode('mp4')).toBe(true)
    expect(autoService._shouldTranscode('webm')).toBe(false)

    const directService = new WdioPuppeteerVideoService({
      outputFormat: 'mp4',
      mp4Mode: 'direct',
    }) as unknown as {
      _forceMp4Transcode: boolean
      _shouldTranscode: (outputFormat: 'webm' | 'mp4') => boolean
    }
    directService._forceMp4Transcode = true
    expect(directService._shouldTranscode('mp4')).toBe(false)

    const transcodeService = new WdioPuppeteerVideoService({
      outputFormat: 'mp4',
      mp4Mode: 'transcode',
    }) as unknown as {
      _shouldTranscode: (outputFormat: 'webm' | 'mp4') => boolean
    }
    expect(transcodeService._shouldTranscode('mp4')).toBe(true)

    const overrideService = new WdioPuppeteerVideoService({
      outputFormat: 'mp4',
      mp4Mode: 'direct',
      transcode: { enabled: true },
    }) as unknown as {
      _shouldTranscode: (outputFormat: 'webm' | 'mp4') => boolean
    }
    expect(overrideService._shouldTranscode('mp4')).toBe(true)
  })

  it('configureMp4RecordingMode enables fallback in auto mode only', async () => {
    const autoService = new WdioPuppeteerVideoService({
      outputFormat: 'mp4',
      mp4Mode: 'auto',
    }) as unknown as {
      _forceMp4Transcode: boolean
      _resolveFfmpegPath: () => string
      _supportsDirectMp4: (ffmpegPath: string) => Promise<boolean>
      _configureMp4RecordingMode: () => Promise<void>
    }

    autoService._resolveFfmpegPath = () => '/tmp/ffmpeg'
    autoService._supportsDirectMp4 = async () => false
    await autoService._configureMp4RecordingMode()
    expect(autoService._forceMp4Transcode).toBe(true)

    const directService = new WdioPuppeteerVideoService({
      outputFormat: 'mp4',
      mp4Mode: 'direct',
    }) as unknown as {
      _forceMp4Transcode: boolean
      _resolveFfmpegPath: () => string
      _supportsDirectMp4: (ffmpegPath: string) => Promise<boolean>
      _configureMp4RecordingMode: () => Promise<void>
    }
    directService._resolveFfmpegPath = () => '/tmp/ffmpeg'
    directService._supportsDirectMp4 = async () => false
    await directService._configureMp4RecordingMode()
    expect(directService._forceMp4Transcode).toBe(false)
  })

  it('configureMp4RecordingMode respects explicit transcode override', async () => {
    const service = new WdioPuppeteerVideoService({
      outputFormat: 'mp4',
      mp4Mode: 'auto',
      transcode: { enabled: true },
    }) as unknown as {
      _forceMp4Transcode: boolean
      _configureMp4RecordingMode: () => Promise<void>
    }

    service._forceMp4Transcode = false
    await service._configureMp4RecordingMode()
    expect(service._forceMp4Transcode).toBe(false)
  })

  it('marks EPIPE and destroyed-stream write errors as benign', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _isBenignStreamWriteError: (error: NodeJS.ErrnoException) => boolean
    }

    expect(
      service._isBenignStreamWriteError({
        name: 'Error',
        message: 'broken pipe',
        code: 'EPIPE',
      }),
    ).toBe(true)
    expect(
      service._isBenignStreamWriteError({
        name: 'Error',
        message: 'Cannot call write after a stream was destroyed.',
      }),
    ).toBe(true)
    expect(
      service._isBenignStreamWriteError({
        name: 'Error',
        message: 'some other write error',
      }),
    ).toBe(false)
  })

  it('buildTestSlug is deterministic, sanitized, and retry-aware', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _buildTestSlug: (test: Frameworks.Test) => string
    }

    const retriedTest = createTest({
      title: 'My Test Name!!!',
      fullTitle: 'suite My Test Name!!!',
      _currentRetry: 2,
    })

    const slugOne = service._buildTestSlug(retriedTest)
    const slugTwo = service._buildTestSlug(retriedTest)

    expect(slugOne).toBe(slugTwo)
    expect(slugOne).toMatch(/^my_test_name_[a-f0-9]{8}_retry2$/)

    const differentTest = createTest({
      title: 'My Test Name!!!',
      fullTitle: 'suite another title',
    })
    const differentSlug = service._buildTestSlug(differentTest)
    expect(slugOne).not.toBe(differentSlug)
  })

  it('buildTestSlug includes session token when available', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _sessionIdToken: string
      _buildTestSlug: (test: Frameworks.Test) => string
    }

    service._sessionIdToken = 'abc123def456'
    const testCase = createTest({
      title: 'My Test Name!!!',
      fullTitle: 'suite My Test Name!!!',
    })

    const slug = service._buildTestSlug(testCase)
    expect(slug).toMatch(/^my_test_name_abc123def456_[a-f0-9]{8}$/)
  })

  it('buildTestSlug falls back to fullName when title is generic', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _buildTestSlug: (test: Frameworks.Test, context?: unknown) => string
    }

    const slug = service._buildTestSlug(
      createTest({
        title: 'index',
        fullTitle: 'index',
        fullName: 'should support jasmine naming',
      }),
    )

    expect(slug).toMatch(/^should_support_jasmine_naming_[a-f0-9]{8}$/)
  })

  it('buildTestSlug can use cucumber pickle name from context', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _buildTestSlug: (test: Frameworks.Test, context?: unknown) => string
    }

    const slug = service._buildTestSlug(
      createTest({ title: 'index', fullTitle: '', fullName: '' }),
      {
        pickle: { name: 'user can check out successfully' },
      },
    )

    expect(slug).toMatch(/^user_can_check_out_successfully_[a-f0-9]{8}$/)
  })

  it('buildTestSlug supports full-session-only filename style', () => {
    const service = new WdioPuppeteerVideoService({
      fileNameStyle: 'sessionFull',
    }) as unknown as {
      _sessionIdToken: string
      _sessionIdFullToken: string
      _buildTestSlug: (test: Frameworks.Test, context?: unknown) => string
    }

    service._sessionIdToken = 'abc123def456'
    service._sessionIdFullToken = '550e8400_e29b_41d4_a716_446655440000'
    const slug = service._buildTestSlug(createTest({ title: 'ignored' }))

    expect(slug).toBe('550e8400_e29b_41d4_a716_446655440000')
  })

  it('buildTestSlug supports short-session-only filename style', () => {
    const service = new WdioPuppeteerVideoService({
      fileNameStyle: 'session',
    }) as unknown as {
      _sessionIdToken: string
      _buildTestSlug: (test: Frameworks.Test, context?: unknown) => string
    }

    service._sessionIdToken = 'abc123def456'
    const slug = service._buildTestSlug(createTest({ title: 'ignored' }))

    expect(slug).toBe('abc123def456')
  })

  it('buildTestSlug appends retry token for session-only filename style', () => {
    const service = new WdioPuppeteerVideoService({
      fileNameStyle: 'session',
    }) as unknown as {
      _sessionIdToken: string
      _buildTestSlug: (test: Frameworks.Test, context?: unknown) => string
    }

    service._sessionIdToken = 'abc123def456'
    const slug = service._buildTestSlug(
      createTest({ title: 'ignored', _currentRetry: 2 }),
    )

    expect(slug).toBe('abc123def456_retry2')
  })

  it('reserveUniqueSlug appends run suffix to prevent collisions', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _reserveUniqueSlug: (baseSlug: string) => string
    }

    expect(service._reserveUniqueSlug('same_slug')).toBe('same_slug')
    expect(service._reserveUniqueSlug('same_slug')).toBe('same_slug_run2')
  })

  it('buildSessionIdToken prefers first guid segment', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _buildSessionIdToken: (sessionId: string | undefined) => string
    }

    const token = service._buildSessionIdToken(
      '550e8400-e29b-41d4-a716-446655440000',
    )
    expect(token).toBe('550e8400')
  })

  it('buildTestSlug keeps session/hash and a tiny title token when constrained', () => {
    const service = new WdioPuppeteerVideoService({
      maxFileNameLength: 30,
      fileNameOverflowStrategy: 'session',
    }) as unknown as {
      _sessionIdToken: string
      _buildTestSlug: (test: Frameworks.Test) => string
    }

    service._sessionIdToken = 'abc123def456'
    const slug = service._buildTestSlug(
      createTest({
        title:
          'this is a very long test title that should not be used when session overflow strategy is enabled and the filename budget is tiny',
      }),
    )

    expect(slug).toMatch(/^this_abc123def456_[a-f0-9]{8}$/)
  })

  it('buildTestSlug truncates title when constrained with truncate strategy', () => {
    const service = new WdioPuppeteerVideoService({
      maxFileNameLength: 40,
      fileNameOverflowStrategy: 'truncate',
    }) as unknown as {
      _sessionIdToken: string
      _buildTestSlug: (test: Frameworks.Test) => string
      _getMaxSlugLength: () => number
    }

    service._sessionIdToken = 'abc123def456'
    const slug = service._buildTestSlug(
      createTest({
        title:
          'this is a very long test title that should be truncated to respect the filename budget',
      }),
    )
    const maxSlugLength = service._getMaxSlugLength()

    expect(slug).toMatch(/^this_[a-z0-9_]*abc123def456_[a-f0-9]{8}$/)
    expect(slug.length).toBeLessThanOrEqual(maxSlugLength)
  })

  it('segment path includes slug, segment, and requested format', () => {
    const service = new WdioPuppeteerVideoService({
      outputDir: './videos-output',
    }) as unknown as {
      _currentTestSlug: string
      _currentSegment: number
      _getSegmentPath: (format: 'webm' | 'mp4') => string
    }

    service._currentTestSlug = 'test_slug_deadbeef'
    service._currentSegment = 3

    const segmentPath = service._getSegmentPath('mp4')
    expect(path.basename(segmentPath)).toBe('test_slug_deadbeef_part3.mp4')
    expect(segmentPath).toContain('videos-output')
  })

  it('merged path uses slug without segment suffix', () => {
    const service = new WdioPuppeteerVideoService({
      outputDir: './videos-output',
    }) as unknown as {
      _currentTestSlug: string
      _getMergedOutputPath: (format: 'webm' | 'mp4') => string
    }

    service._currentTestSlug = 'test_slug_deadbeef'
    const mergedPath = service._getMergedOutputPath('mp4')
    expect(path.basename(mergedPath)).toBe('test_slug_deadbeef.mp4')
  })

  it('extractPartNumber parses segment index from filename', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _extractPartNumber: (filePath: string) => number
    }

    expect(service._extractPartNumber('/tmp/video_part12.mp4')).toBe(12)
    expect(service._extractPartNumber('/tmp/video.mp4')).toBe(
      Number.MAX_SAFE_INTEGER,
    )
  })

  it('ffmpeg path resolution prefers explicit option', () => {
    const service = new WdioPuppeteerVideoService({
      ffmpegPath: '/custom/ffmpeg',
    }) as unknown as {
      _resolveFfmpegPath: () => string
    }

    expect(service._resolveFfmpegPath()).toBe('/custom/ffmpeg')
  })

  it('ffmpeg path resolution prefers discovered binary when available', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _resolvedFfmpegPath?: string
      _resolveFfmpegPath: () => string
    }

    service._resolvedFfmpegPath = '/detected/ffmpeg'
    expect(service._resolveFfmpegPath()).toBe('/detected/ffmpeg')
  })

  it('ffmpeg path resolution uses FFMPEG_PATH when option is unset', () => {
    const previousFfmpegPath = process.env.FFMPEG_PATH
    try {
      process.env.FFMPEG_PATH = '/env/ffmpeg'

      const service = new WdioPuppeteerVideoService({}) as unknown as {
        _resolveFfmpegPath: () => string
      }
      expect(service._resolveFfmpegPath()).toBe('/env/ffmpeg')
    } finally {
      process.env.FFMPEG_PATH = previousFfmpegPath
    }
  })

  it('ffmpeg path defaults to PATH lookup when no override exists', () => {
    const previousFfmpegPath = process.env.FFMPEG_PATH
    try {
      delete process.env.FFMPEG_PATH

      const service = new WdioPuppeteerVideoService({}) as unknown as {
        _resolveFfmpegPath: () => string
      }
      expect(service._resolveFfmpegPath()).toBe('ffmpeg')
    } finally {
      process.env.FFMPEG_PATH = previousFfmpegPath
    }
  })

  it('normalizePositiveInt floors positive numbers and rejects invalid input', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _normalizePositiveInt: (
        value: number | undefined,
        fallback: number,
      ) => number
    }

    expect(service._normalizePositiveInt(29.9, 10)).toBe(29)
    expect(service._normalizePositiveInt(0, 10)).toBe(10)
    expect(service._normalizePositiveInt(Number.NaN, 10)).toBe(10)
    expect(service._normalizePositiveInt(undefined, 10)).toBe(10)
  })

  it('normalizeLogLevel supports WDIO-style levels and fallback', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _normalizeLogLevel: (level: string | undefined) => string
    }

    expect(service._normalizeLogLevel('trace')).toBe('trace')
    expect(service._normalizeLogLevel('debug')).toBe('debug')
    expect(service._normalizeLogLevel('info')).toBe('info')
    expect(service._normalizeLogLevel('warn')).toBe('warn')
    expect(service._normalizeLogLevel('error')).toBe('error')
    expect(service._normalizeLogLevel('silent')).toBe('silent')
    expect(service._normalizeLogLevel('verbose')).toBe('warn')
    expect(service._normalizeLogLevel(undefined)).toBe('warn')
  })

  it('resolveWdioLogLevel reads browser options when available', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _resolveWdioLogLevel: (browser: unknown) => string | undefined
    }

    const browserStub = {
      options: { logLevel: 'debug' },
      config: { logLevel: 'error' },
    }

    expect(service._resolveWdioLogLevel(browserStub)).toBe('debug')
  })
})
