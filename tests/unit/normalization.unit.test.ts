import { describe, expect, it } from 'vitest'
import {
  describeError,
  getEffectiveMaxFilenameLength,
  isBenignStreamWriteError,
  normalizeFileNameStyle,
  normalizeMergeOptions,
  normalizeMp4Mode,
  normalizeNonNegativeInt,
  normalizeOutputFormat,
  normalizePatternList,
  normalizePositiveInt,
  normalizeRecordingStartMode,
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

  it('normalizes MP4 modes without accepting unknown values', () => {
    expect(normalizeMp4Mode('auto')).toBe('auto')
    expect(normalizeMp4Mode('direct')).toBe('direct')
    expect(normalizeMp4Mode('transcode')).toBe('transcode')
    expect(normalizeMp4Mode('invalid' as never)).toBe('auto')
  })

  it('normalizes filename styles without accepting unknown values', () => {
    expect(normalizeFileNameStyle('test')).toBe('test')
    expect(normalizeFileNameStyle('testFull')).toBe('testFull')
    expect(normalizeFileNameStyle('session')).toBe('session')
    expect(normalizeFileNameStyle('sessionFull')).toBe('sessionFull')
    expect(normalizeFileNameStyle('invalid' as never)).toBe('test')
  })

  it('normalizes recording start modes without accepting unknown values', () => {
    expect(normalizeRecordingStartMode('blocking')).toBe('blocking')
    expect(normalizeRecordingStartMode('fastFail')).toBe('fastFail')
    expect(normalizeRecordingStartMode('invalid' as never)).toBe('blocking')
  })

  it('floors integer options and applies their distinct lower-bound rules', () => {
    expect(normalizePositiveInt(29.9, 10)).toBe(29)
    expect(normalizePositiveInt(0, 10)).toBe(10)
    expect(normalizeNonNegativeInt(0, 7)).toBe(0)
    expect(normalizeNonNegativeInt(2.9, 7)).toBe(2)
    expect(normalizeNonNegativeInt(-1, 7)).toBe(7)
  })

  it('classifies only known stream-shutdown errors as benign', () => {
    expect(
      isBenignStreamWriteError({
        name: 'Error',
        message: 'broken pipe',
        code: 'EPIPE',
      }),
    ).toBe(true)
    expect(
      isBenignStreamWriteError({
        name: 'Error',
        message: 'Cannot call write after a stream was destroyed',
      }),
    ).toBe(true)
    expect(
      isBenignStreamWriteError({
        name: 'Error',
        message: 'permission denied',
        code: 'EACCES',
      }),
    ).toBe(false)
  })

  it('normalizes pattern lists and removes invalid or duplicate values', () => {
    expect(
      normalizePatternList([' @Smoke ', '', '  ', '@smoke', 42 as never]),
    ).toEqual(['@smoke'])
    expect(normalizePatternList(undefined)).toEqual([])
  })

  it('applies platform filename defaults and exhausted Windows path budgets', () => {
    expect(getEffectiveMaxFilenameLength({ outputDir: '' }, 'linux')).toBe(255)
    expect(
      getEffectiveMaxFilenameLength(
        {
          maxFileNameLength: 100,
          outputDir: 'x'.repeat(300),
        },
        'win32',
      ),
    ).toBe(100)
  })

  it('describes string and primitive errors without losing their value', () => {
    expect(describeError('target closed')).toBe('target closed')
    expect(describeError(404)).toBe('404')
  })
})
