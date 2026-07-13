import { describe, expect, it } from 'vitest'
import {
  normalizeMergeOptions,
  normalizeOutputFormat,
  normalizeTranscodeOptions,
} from '../../src/service/normalization.js'

describe('normalization helpers', () => {
  it('normalizeOutputFormat accepts supported formats and falls back to webm', () => {
    expect(normalizeOutputFormat(undefined)).toBe('webm')
    expect(normalizeOutputFormat('webm')).toBe('webm')
    expect(normalizeOutputFormat('mp4')).toBe('mp4')
    expect(normalizeOutputFormat('avi' as never)).toBe('webm')
    expect(normalizeOutputFormat('' as never)).toBe('webm')
  })

  it('normalizeTranscodeOptions applies defaults and keeps only valid option shapes', () => {
    expect(normalizeTranscodeOptions(undefined)).toEqual({
      deleteOriginal: true,
    })
    expect(normalizeTranscodeOptions('invalid' as never)).toEqual({
      deleteOriginal: true,
    })
    expect(
      normalizeTranscodeOptions({
        enabled: true,
        deleteOriginal: false,
        ffmpegArgs: ['-crf', '28'],
      }),
    ).toEqual({
      enabled: true,
      deleteOriginal: false,
      ffmpegArgs: ['-crf', '28'],
    })
  })

  it('normalizeTranscodeOptions ignores invalid booleans and empty ffmpeg args', () => {
    expect(
      normalizeTranscodeOptions({
        enabled: 'true',
        deleteOriginal: 'false',
        ffmpegArgs: ['', '  ', '-vf', ' scale=1280:720 ', 28],
      } as never),
    ).toEqual({
      deleteOriginal: true,
      ffmpegArgs: ['-vf', ' scale=1280:720 '],
    })
  })

  it('normalizeMergeOptions applies defaults and keeps strict booleans only', () => {
    expect(normalizeMergeOptions(undefined)).toEqual({
      deleteSegments: true,
    })
    expect(normalizeMergeOptions(['invalid'] as never)).toEqual({
      deleteSegments: true,
    })
    expect(
      normalizeMergeOptions({
        enabled: true,
        deleteSegments: false,
      }),
    ).toEqual({
      enabled: true,
      deleteSegments: false,
    })
    expect(
      normalizeMergeOptions({
        enabled: 'true',
        deleteSegments: 'false',
      } as never),
    ).toEqual({
      deleteSegments: true,
    })
  })
})
