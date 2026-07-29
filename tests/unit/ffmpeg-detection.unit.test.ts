import { describe, expect, it } from 'vitest'
import {
  assertE2eFfmpegPolicy,
  type FfmpegDetectionResult,
} from '../scripts/ffmpeg-detection.js'

const unavailableFfmpeg: FfmpegDetectionResult = {
  available: false,
  checkedCandidates: ['ffmpeg', '/fixture/ffmpeg'],
}

describe('E2E FFmpeg policy', () => {
  it('allows an available FFmpeg binary', () => {
    expect(() =>
      assertE2eFfmpegPolicy(
        {
          available: true,
          resolvedPath: '/fixture/ffmpeg',
          checkedCandidates: ['/fixture/ffmpeg'],
        },
        {},
      ),
    ).not.toThrow()
  })

  it('requires an explicit opt-out for local runs without FFmpeg', () => {
    expect(() => assertE2eFfmpegPolicy(unavailableFfmpeg, {})).toThrow(
      'WDIO_ALLOW_MISSING_FFMPEG=1',
    )
  })

  it('allows the explicit local FFmpeg opt-out', () => {
    expect(() =>
      assertE2eFfmpegPolicy(unavailableFfmpeg, {
        WDIO_ALLOW_MISSING_FFMPEG: 'true',
      }),
    ).not.toThrow()
  })

  it('rejects the FFmpeg opt-out in CI', () => {
    expect(() =>
      assertE2eFfmpegPolicy(unavailableFfmpeg, {
        CI: 'true',
        WDIO_ALLOW_MISSING_FFMPEG: 'true',
      }),
    ).toThrow('FFmpeg is required in CI')
  })
})
