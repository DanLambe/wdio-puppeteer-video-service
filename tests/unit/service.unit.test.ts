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
        maxFileNameLength?: number
        fileNameOverflowStrategy?: string
        transcode?: { deleteOriginal?: boolean }
        mergeSegments?: { deleteSegments?: boolean }
      }
      _logLevel: string
    }

    expect(service._options.outputDir).toBe('videos')
    expect(service._options.videoWidth).toBe(1280)
    expect(service._options.videoHeight).toBe(720)
    expect(service._options.fps).toBe(30)
    expect(service._options.maxFileNameLength).toBeGreaterThanOrEqual(40)
    expect(service._options.fileNameOverflowStrategy).toBe('truncate')
    expect(service._options.transcode?.deleteOriginal).toBe(true)
    expect(service._options.mergeSegments?.deleteSegments).toBe(true)
    expect(service._logLevel).toBe('warn')
  })

  it('constructor honors explicit service logLevel', () => {
    const service = new WdioPuppeteerVideoService({
      logLevel: 'silent',
    }) as unknown as {
      _logLevel: string
    }

    expect(service._logLevel).toBe('silent')
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
