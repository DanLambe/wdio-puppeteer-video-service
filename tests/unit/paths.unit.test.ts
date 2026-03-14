import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildConcatList,
  collectCurrentTestSegmentPaths,
  extractPartNumber,
  getMergedOutputPath,
  getSegmentPath,
  resolveMergeFormat,
} from '../../src/service/paths.js'

describe('paths buildConcatList', () => {
  it('formats a path as a concat file entry with forward slashes', () => {
    // Use path.resolve to mirror buildConcatList's own resolution
    const inputPath = path.resolve('videos', 'video_part1.webm')
    const result = buildConcatList([inputPath])
    const normalizedInput = inputPath.replaceAll('\\', '/')
    expect(result).toBe(`file '${normalizedInput}'`)
  })

  it('joins multiple entries with newlines', () => {
    const p1 = path.resolve('videos', 'video_part1.webm')
    const p2 = path.resolve('videos', 'video_part2.webm')
    const result = buildConcatList([p1, p2])
    const lines = result.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('video_part1.webm')
    expect(lines[1]).toContain('video_part2.webm')
  })

  it('escapes single quotes per ffmpeg concat demuxer spec', () => {
    // ffmpeg concat demuxer docs show: file '/path/file 3'\''.wav'
    // replaceAll("'", "'\\''") on "dan's" produces: dan'\''s
    const inputPath = path.resolve('videos', "dan's video_part1.webm")
    const result = buildConcatList([inputPath])
    // The ' between dan and s must be escaped as '\'' (close, \', reopen)
    expect(result).toContain(String.raw`dan'\''s`)
  })

  it('output never contains backslashes (Windows paths normalized)', () => {
    // path.join uses platform separators; buildConcatList must normalize them
    const platformPath = path.join('videos', 'subdir', 'video_part1.webm')
    const result = buildConcatList([platformPath])
    // The content between the single quotes should have only forward slashes
    const inner = result.slice("file '".length, result.lastIndexOf("'"))
    expect(inner).not.toContain('\\')
  })

  it('returns an empty string for an empty segment list', () => {
    expect(buildConcatList([])).toBe('')
  })
})

describe('paths extractPartNumber', () => {
  it('parses the segment index from a filename', () => {
    expect(
      extractPartNumber(path.resolve('videos', 'my_test_part1.webm')),
    ).toBe(1)
    expect(
      extractPartNumber(path.resolve('videos', 'my_test_part12.mp4')),
    ).toBe(12)
    expect(
      extractPartNumber(path.resolve('videos', 'my_test_part9999.webm')),
    ).toBe(9999)
  })

  it('returns MAX_SAFE_INTEGER when no part number is found', () => {
    expect(extractPartNumber(path.resolve('videos', 'my_test.webm'))).toBe(
      Number.MAX_SAFE_INTEGER,
    )
    expect(extractPartNumber(path.resolve('videos', 'merged.mp4'))).toBe(
      Number.MAX_SAFE_INTEGER,
    )
  })

  it('sorts segments in correct numeric order by part number', () => {
    const base = path.resolve('videos')
    const segments = [
      path.join(base, 'slug_part3.webm'),
      path.join(base, 'slug_part1.webm'),
      path.join(base, 'slug_part10.webm'),
      path.join(base, 'slug_part2.webm'),
    ]
    const sorted = [...segments].sort(
      (a, b) => extractPartNumber(a) - extractPartNumber(b),
    )
    expect(sorted).toEqual([
      path.join(base, 'slug_part1.webm'),
      path.join(base, 'slug_part2.webm'),
      path.join(base, 'slug_part3.webm'),
      path.join(base, 'slug_part10.webm'),
    ])
  })
})

describe('paths artifact path helpers', () => {
  it('collects and sorts only segments for the current test slug', () => {
    const segments = new Set([
      path.join('videos', 'checkout_part10.webm'),
      path.join('videos', 'other_part1.webm'),
      path.join('videos', 'checkout_part2.webm'),
      path.join('videos', 'checkout_part1.webm'),
    ])

    expect(collectCurrentTestSegmentPaths('checkout', segments)).toEqual([
      path.join('videos', 'checkout_part1.webm'),
      path.join('videos', 'checkout_part2.webm'),
      path.join('videos', 'checkout_part10.webm'),
    ])
    expect(collectCurrentTestSegmentPaths('', segments)).toEqual([])
  })

  it('builds segment and merged output paths with defaults and explicit formats', () => {
    expect(getSegmentPath(undefined, 'checkout', 3)).toBe(
      path.join('videos', 'checkout_part3.webm'),
    )
    expect(getSegmentPath('artifacts', 'checkout', 3, 'mp4')).toBe(
      path.join('artifacts', 'checkout_part3.mp4'),
    )
    expect(getMergedOutputPath(undefined, 'checkout')).toBe(
      path.join('videos', 'checkout.webm'),
    )
    expect(getMergedOutputPath('artifacts', 'checkout', 'mp4')).toBe(
      path.join('artifacts', 'checkout.mp4'),
    )
  })

  it('resolves merge formats and warns on unsupported or mixed segment inputs', () => {
    const warnMessages: string[] = []
    const warn = (message: string) => {
      warnMessages.push(message)
    }

    expect(resolveMergeFormat([], 'segment merge', warn)).toBeUndefined()
    expect(
      resolveMergeFormat(['videos/segment_part1.avi'], 'segment merge', warn),
    ).toBeUndefined()
    expect(
      resolveMergeFormat(
        ['videos/segment_part1.webm', 'videos/segment_part2.mp4'],
        'segment merge',
        warn,
      ),
    ).toBeUndefined()
    expect(
      resolveMergeFormat(
        ['videos/segment_part1.webm', 'videos/segment_part2.webm'],
        'segment merge',
        warn,
      ),
    ).toBe('webm')

    expect(
      warnMessages.some((message) => message.includes('Unsupported segment format')),
    ).toBe(true)
    expect(
      warnMessages.some((message) => message.includes('segment formats are mixed')),
    ).toBe(true)
  })
})
