import { describe, expect, it } from 'vitest'
import {
  buildMediaMetadataArgs,
  parseMediaDimensions,
} from '../../src/service/media-metadata.js'

describe('retained video metadata', () => {
  it.each([
    ['Stream #0:0: Video: vp9, yuv444p, 801x401, 30 fps', 801, 401],
    [
      '  Stream #0:0[0x1](und): Video: h264, yuv420p, 802x402 [SAR 1:1 DAR 401:201]',
      802,
      402,
    ],
    ['Stream #0:0: Video: vp9, gbrp, 400x200, 30 fps', 400, 200],
    ['Stream #0:1: Video: vp9, yuv444p, 1x1, 30 fps', 1, 1],
  ])('reads encoded dimensions from %s', (metadata, width, height) => {
    expect(parseMediaDimensions(String(metadata))).toEqual({ width, height })
  })

  it.each([
    '',
    'Input #0, matroska,webm, from video-800x600.webm',
    'Stream #0:0: Audio: opus, 48000 Hz',
    'Stream #0:0: Video: vp9, 0x600',
    'Stream #0:0: Video: vp9, 800x0',
    'Stream #0:0: Video: vp9, 999999999999999999x600',
    'Stream #0:0: Video: vp9, 800x999999999999999999',
  ])('omits unavailable or invalid dimensions for %j', (metadata) => {
    expect(parseMediaDimensions(metadata)).toBeUndefined()
  })

  it('selects the input video stream, not a filename or output stream', () => {
    expect(
      parseMediaDimensions(
        [
          "Input #0, mov,mp4, from 'video-800x600.mp4':",
          '  Stream #0:0: Audio: aac, 48000 Hz',
          '  Stream #0:1: Video: h264, yuv420p, 402x202',
          '  Stream #1:0: Video: h264, yuv420p, 1280x720',
        ].join('\r\n'),
      ),
    ).toEqual({ width: 402, height: 202 })
  })

  it('uses a metadata-only stream-copy operation with no output file', () => {
    expect(buildMediaMetadataArgs('C:/videos/test clip.webm')).toEqual([
      '-hide_banner',
      '-nostdin',
      '-i',
      'C:/videos/test clip.webm',
      '-map',
      '0:v:0',
      '-c:v',
      'copy',
      '-frames:v',
      '0',
      '-f',
      'null',
      '-',
    ])
  })
})
