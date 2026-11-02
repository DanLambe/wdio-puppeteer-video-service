import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFfmpegVersion } from '../../src/service/ffmpeg.js'
import { resolveTimestampPassthroughArgs } from '../../src/service/post-process.js'
import { requireE2eFfmpeg } from '../scripts/ffmpeg-detection.js'
import {
  checkSegment,
  decodeMarkerFrames,
  MARKER_CELL_PX,
  MARKER_CELLS,
  MARKER_INSET_PX,
  MARKER_VIEWPORT_WIDTH,
  type MarkerTab,
  markerCells,
} from '../utils/action-markers.js'

// Real FFmpeg encodes a fixture-like page whose strip changes mid-video, so
// decoding must find the strip where the fixture draws it, at any scale.

let ffmpegPath = ''
let passthrough: readonly string[] = []
let directory = ''

beforeAll(async () => {
  const detection = await requireE2eFfmpeg()
  if (!detection.resolvedPath) {
    throw new Error('FFmpeg is required for the action marker tests')
  }
  ffmpegPath = detection.resolvedPath
  passthrough = resolveTimestampPassthroughArgs(
    await readFfmpegVersion(ffmpegPath),
  )
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'action-markers-'))
})

afterAll(async () => {
  await fs.rm(directory, { recursive: true, force: true })
})

/** Boxes for one strip state, shown while `enable` holds. */
const stripBoxes = (tab: MarkerTab, value: number, enable: string) => {
  const left =
    MARKER_VIEWPORT_WIDTH - MARKER_INSET_PX - MARKER_CELLS * MARKER_CELL_PX
  return markerCells(tab, value).map(
    (dark, cell) =>
      `drawbox=x=${left + cell * MARKER_CELL_PX}:y=${MARKER_INSET_PX}:w=${MARKER_CELL_PX}:h=${MARKER_CELL_PX}:color=${dark ? 'black' : 'white'}:t=fill:enable='${enable}'`,
  )
}

const encode = (
  name: string,
  viewportHeight: number,
  output: readonly string[],
): string => {
  const file = path.join(directory, name)
  const filters = [
    ...stripBoxes(1, 2, 'lt(t,0.5)'),
    ...stripBoxes(1, 3, 'between(t,0.5,0.8)'),
    ...stripBoxes(1, 4, 'gt(t,0.8)'),
  ]
  const result = spawnSync(ffmpegPath, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x00e020:s=${MARKER_VIEWPORT_WIDTH}x${viewportHeight}:r=30:d=1.2`,
    '-vf',
    [...filters, ...output.slice(0, 1)].join(','),
    ...output.slice(1),
    file,
  ])
  if (result.status !== 0) {
    throw new Error(result.stderr.toString())
  }
  return file
}

describe('decoding the action marker strip', () => {
  it('reads a full-size H.264 recording frame by frame', async () => {
    const file = encode('full.mp4', 1080, ['format=yuv420p', '-c:v', 'libx264'])

    const frames = await decodeMarkerFrames(ffmpegPath, file, passthrough)

    expect(frames).toHaveLength(36)
    expect(frames.every((frame) => frame.marker?.tab === 1)).toBe(true)
    expect(checkSegment(frames, { tab: 1, values: [2, 3, 4] })).toMatchObject({
      ok: true,
      observed: [2, 3, 4],
    })
  })

  it('reads a downscaled VP8 recording of a shorter viewport', async () => {
    // DevTools' default screencast: at most 1280 wide, from a 1920×938 page.
    const file = encode('scaled.webm', 938, [
      'scale=1280:-2',
      '-c:v',
      'libvpx',
      '-b:v',
      '1M',
    ])

    const frames = await decodeMarkerFrames(ffmpegPath, file, passthrough)

    expect(checkSegment(frames, { tab: 1, values: [2, 3, 4] })).toMatchObject({
      ok: true,
      observed: [2, 3, 4],
    })
  })
})
