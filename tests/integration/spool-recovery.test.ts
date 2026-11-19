import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SPOOL_DIR_NAME } from '../../src/service/constants.js'
import { createMatroskaHeader } from '../../src/service/matroska-writer.js'
import { recoverOrphanedSpools } from '../../src/service/spool-recovery.js'
import { requireE2eFfmpeg } from '../scripts/ffmpeg-detection.js'
import { blockGroupStream, spoolName } from '../utils/spool-fixtures.js'

// Real FFmpeg proves the fixtures are playable media, then the real launcher
// recovery runs over them in a fresh run directory (review 12, R12-2).

const RUN_ID = 'review12-owned'
const TRACK = { codec: 'png', fps: 25, height: 16, width: 16 } as const
const RGB_FRAME_BYTES = 16 * 16 * 3

let ffmpegPath = ''
let outputDir = ''

beforeAll(async () => {
  const detection = await requireE2eFfmpeg()
  if (!detection.resolvedPath) {
    throw new Error('FFmpeg is required for the spool recovery tests')
  }
  ffmpegPath = detection.resolvedPath
})

beforeEach(async () => {
  outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-spool-recovery-'))
})

afterEach(async () => {
  await fs.rm(outputDir, { force: true, recursive: true })
})

const redPng = (): Buffer => {
  const result = spawnSync(ffmpegPath, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=16x16',
    '-frames:v',
    '1',
    '-threads',
    '1',
    '-f',
    'image2pipe',
    '-vcodec',
    'png',
    'pipe:1',
  ])
  if (result.status !== 0) {
    throw new Error(`FFmpeg could not make the PNG: ${String(result.stderr)}`)
  }
  return result.stdout
}

/** The first frame FFmpeg decodes from a Matroska stream, as raw RGB. */
const decodeFirstFrame = (stream: Buffer): Buffer => {
  const result = spawnSync(
    ffmpegPath,
    [
      '-v',
      'error',
      '-f',
      'matroska',
      '-i',
      'pipe:0',
      '-frames:v',
      '1',
      '-threads',
      '1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    { input: stream },
  )
  if (result.status !== 0) {
    throw new Error(`FFmpeg could not decode: ${String(result.stderr)}`)
  }
  return result.stdout
}

describe('orphaned spool recovery with real media', () => {
  it('keeps a decodable BlockGroup spool and an unrelated .mkv', async () => {
    const stream = blockGroupStream(redPng(), TRACK)
    const decoded = decodeFirstFrame(stream)
    expect(decoded).toHaveLength(RGB_FRAME_BYTES)
    const runDirectory = path.join(outputDir, SPOOL_DIR_NAME, RUN_ID)
    await fs.mkdir(runDirectory, { recursive: true })
    const spoolPath = path.join(runDirectory, spoolName('kept', 1))
    const notesPath = path.join(runDirectory, 'notes.mkv')
    await fs.writeFile(spoolPath, stream)
    await fs.writeFile(notesPath, createMatroskaHeader(TRACK))

    const result = await recoverOrphanedSpools({
      log: () => undefined,
      outputDir,
      runId: RUN_ID,
    })

    const framesPath = path.join(outputDir, 'kept_part1.frames.mkv')
    expect(result).toEqual({
      deleted: [],
      directoryRemoved: false,
      left: [],
      recovered: [framesPath],
    })
    expect(decodeFirstFrame(await fs.readFile(framesPath))).toEqual(decoded)
    expect(await fs.readFile(notesPath)).toEqual(createMatroskaHeader(TRACK))
  })
})
