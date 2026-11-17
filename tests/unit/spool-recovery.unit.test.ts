import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ClockBoundary,
  systemClock,
} from '../../src/service/boundaries.js'
import { SPOOL_DIR_NAME } from '../../src/service/constants.js'
import type { ServiceLogger } from '../../src/service/logging.js'
import {
  createMatroskaHeader,
  MatroskaBlockWriter,
} from '../../src/service/matroska-writer.js'
import {
  classifySpoolPrefix,
  recoverOrphanedSpools,
  type SpoolRecoveryOptions,
} from '../../src/service/spool-recovery.js'
import {
  blockGroupStream,
  clusterOpening,
  ebmlElement,
  spoolName,
  testSpoolUuid,
} from '../utils/spool-fixtures.js'

const RUN_ID = 'current-run'
const TRACK = { codec: 'png', fps: 25, height: 600, width: 800 } as const

let outputDir = ''
let logs: Array<{ level: string; message: string }> = []

const log: ServiceLogger = (level, message) => {
  logs.push({ level, message })
}

beforeEach(async () => {
  outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-spool-recovery-'))
  logs = []
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(outputDir, { force: true, recursive: true })
})

const spoolRoot = (): string => path.join(outputDir, SPOOL_DIR_NAME)
const runDirectory = (runId = RUN_ID): string => path.join(spoolRoot(), runId)

const exists = async (filePath: string): Promise<boolean> =>
  fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false)

/** What a live encoder's input holds before its first image is written. */
const headerOnly = (): Buffer => createMatroskaHeader(TRACK)

/** The stream the recorder writes: a header, then each image as a block. */
const withFrames = (imageBytes = 64, frames = 2): Buffer => {
  const writer = new MatroskaBlockWriter()
  const chunks: Buffer[] = [createMatroskaHeader(TRACK)]
  for (let index = 0; index < frames; index += 1) {
    chunks.push(
      ...writer.frame(Buffer.alloc(imageBytes, index + 1), index * 40),
    )
  }
  return Buffer.concat(chunks)
}

const writeSpool = async (
  name: string,
  content: Buffer | string,
  runId = RUN_ID,
): Promise<string> => {
  const spoolPath = path.join(runDirectory(runId), name)
  await fs.mkdir(path.dirname(spoolPath), { recursive: true })
  await fs.writeFile(spoolPath, content)
  return spoolPath
}

const recover = (overrides: Partial<SpoolRecoveryOptions> = {}) =>
  recoverOrphanedSpools({ log, outputDir, runId: RUN_ID, ...overrides })

const warnings = (): string[] =>
  logs.filter(({ level }) => level === 'warn').map(({ message }) => message)

const noDelay: ClockBoundary = {
  ...systemClock,
  delay: async () => undefined,
}

describe('classifySpoolPrefix', () => {
  it('finds no frame in an empty file or a bare header', () => {
    expect(classifySpoolPrefix(Buffer.alloc(0), true)).toBe('no-frames')
    expect(classifySpoolPrefix(headerOnly(), true)).toBe('no-frames')
  })

  it('finds no frame in a header and a cluster that holds no block', () => {
    const writer = new MatroskaBlockWriter()
    const clusterOpening = Buffer.concat(writer.frame(Buffer.alloc(8), 0))
    // The cluster id, its unknown size and its timestamp, without the block.
    const opening = clusterOpening.subarray(0, 4 + 8 + 3)
    expect(
      classifySpoolPrefix(Buffer.concat([headerOnly(), opening]), true),
    ).toBe('no-frames')
  })

  it('finds a frame in the first block', () => {
    expect(classifySpoolPrefix(withFrames(), true)).toBe('frames')
    expect(classifySpoolPrefix(withFrames(), false)).toBe('frames')
  })

  it('finds a frame whose image is longer than the prefix it was given', () => {
    const stream = withFrames(100_000, 1)
    expect(classifySpoolPrefix(stream.subarray(0, 4_096), false)).toBe('frames')
  })

  it('finds no frame in a header cut off inside an element when it is the whole file', () => {
    const header = headerOnly()
    expect(classifySpoolPrefix(header.subarray(0, 30), true)).toBe('no-frames')
    expect(classifySpoolPrefix(header.subarray(0, 3), true)).toBe('no-frames')
    expect(classifySpoolPrefix(header.subarray(0, 1), true)).toBe('no-frames')
  })

  it('finds no frame in a cluster cut off before its first block has any image', () => {
    const block = Buffer.concat(
      new MatroskaBlockWriter().frame(Buffer.alloc(8), 0).slice(3),
    )
    const opened = Buffer.concat([headerOnly(), clusterOpening()])
    // The block's id alone, then its id and the start of a two-byte size.
    expect(
      classifySpoolPrefix(Buffer.concat([opened, block.subarray(0, 1)]), true),
    ).toBe('no-frames')
    expect(
      classifySpoolPrefix(
        Buffer.concat([opened, Buffer.from([0xa3, 0x40])]),
        true,
      ),
    ).toBe('no-frames')
    // A cluster cut off inside its own id or its timestamp.
    expect(
      classifySpoolPrefix(
        Buffer.concat([headerOnly(), clusterOpening().subarray(0, 2)]),
        true,
      ),
    ).toBe('no-frames')
    expect(
      classifySpoolPrefix(
        Buffer.concat([headerOnly(), clusterOpening().subarray(0, 13)]),
        true,
      ),
    ).toBe('no-frames')
  })

  it('does not decide when the prefix ends before an answer and the file goes on', () => {
    const header = headerOnly()
    expect(classifySpoolPrefix(header, false)).toBe('unrecognized')
    expect(classifySpoolPrefix(header.subarray(0, 30), false)).toBe(
      'unrecognized',
    )
    expect(classifySpoolPrefix(header.subarray(0, 3), false)).toBe(
      'unrecognized',
    )
  })

  it('keeps what it cannot read as a Matroska stream', () => {
    // No valid element id, then an element of unknown size that is not a
    // container the writer produces.
    expect(classifySpoolPrefix(Buffer.from([0x00, 0x00, 0x00]), true)).toBe(
      'unrecognized',
    )
    expect(classifySpoolPrefix(Buffer.from([0xec, 0xff]), true)).toBe(
      'unrecognized',
    )
    expect(classifySpoolPrefix(Buffer.from([0xec, 0x00]), true)).toBe(
      'unrecognized',
    )
  })

  it('does not call an image in a BlockGroup frameless', () => {
    const stream = blockGroupStream(Buffer.alloc(64, 7), TRACK)
    expect(classifySpoolPrefix(stream, true)).toBe('unrecognized')
    // Cut off right after the BlockGroup's id: still not the writer's shape.
    const groupStart = headerOnly().length + clusterOpening().length
    expect(classifySpoolPrefix(stream.subarray(0, groupStart + 1), true)).toBe(
      'unrecognized',
    )
  })

  it('does not skip an element the writer does not write', () => {
    // A finite-sized Void after the header, and one inside the cluster.
    const voidElement = ebmlElement(0xec, Buffer.alloc(4))
    expect(
      classifySpoolPrefix(Buffer.concat([headerOnly(), voidElement]), true),
    ).toBe('unrecognized')
    expect(
      classifySpoolPrefix(
        Buffer.concat([headerOnly(), clusterOpening(), voidElement]),
        true,
      ),
    ).toBe('unrecognized')
  })

  it('does not accept a Segment or Cluster with a size the writer never gives it', () => {
    const header = headerOnly()
    // EBML id (4 bytes), a one-byte size, then the EBML header's body.
    const ebmlLength = 5 + ((header[4] ?? 0) & 0x7f)
    const segmentBody = header.subarray(ebmlLength + 12)
    const finiteSegment = Buffer.concat([
      header.subarray(0, ebmlLength + 4),
      Buffer.from([
        0x40 | (segmentBody.length >> 8),
        segmentBody.length & 0xff,
      ]),
      segmentBody,
    ])
    expect(classifySpoolPrefix(finiteSegment, true)).toBe('unrecognized')
    const finiteCluster = Buffer.concat([
      header,
      Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x83]),
      Buffer.from([0xe7, 0x81, 0x00]),
    ])
    expect(classifySpoolPrefix(finiteCluster, true)).toBe('unrecognized')
  })

  it('does not skip a header element larger than any the writer writes', () => {
    const header = headerOnly()
    // The EBML header claims 5 KiB: skipping it could skip a frame.
    const oversized = Buffer.concat([
      header.subarray(0, 4),
      Buffer.from([0x40 | (5_120 >> 8), 5_120 & 0xff]),
      Buffer.alloc(5_120),
    ])
    expect(classifySpoolPrefix(oversized, true)).toBe('unrecognized')
    expect(classifySpoolPrefix(oversized.subarray(0, 64), true)).toBe(
      'unrecognized',
    )
  })

  it('does not accept the writer elements out of order', () => {
    const header = headerOnly()
    // A second EBML header where the Segment belongs.
    const ebmlLength = 5 + ((header[4] ?? 0) & 0x7f)
    expect(
      classifySpoolPrefix(
        Buffer.concat([header.subarray(0, ebmlLength), header]),
        true,
      ),
    ).toBe('unrecognized')
  })
})

describe('recoverOrphanedSpools', () => {
  it('does nothing and says nothing when the run has no spool directory', async () => {
    await expect(recover()).resolves.toBeUndefined()
    expect(logs).toEqual([])
    expect(await fs.readdir(outputDir)).toEqual([])
  })

  it('does not touch a spool root that holds only other runs', async () => {
    const other = await writeSpool(spoolName('a', 1), withFrames(), 'other-run')

    await expect(recover()).resolves.toBeUndefined()

    expect(await exists(other)).toBe(true)
    expect(logs).toEqual([])
  })

  it('removes an empty run directory together with an empty spool root', async () => {
    await fs.mkdir(runDirectory(), { recursive: true })

    const result = await recover()

    expect(result).toEqual({
      deleted: [],
      directoryRemoved: true,
      left: [],
      recovered: [],
    })
    expect(await exists(spoolRoot())).toBe(false)
    expect(logs).toEqual([])
  })

  it('keeps the spool root while another run still has a directory', async () => {
    await fs.mkdir(runDirectory(), { recursive: true })
    const other = await writeSpool(spoolName('a', 1), withFrames(), 'other-run')

    const result = await recover()

    expect(result?.directoryRemoved).toBe(true)
    expect(await exists(runDirectory())).toBe(false)
    expect(await exists(other)).toBe(true)
  })

  it.each([
    ['an empty file', () => ''],
    ['a header only', headerOnly],
    [
      'a header and a cluster with no block',
      () => Buffer.concat([headerOnly(), clusterOpening()]),
    ],
    ['a header cut off inside an element', () => headerOnly().subarray(0, 30)],
  ])('deletes a spool that holds no frame: %s', async (_name, content) => {
    const spoolPath = await writeSpool(spoolName('checkout', 1), content())

    const result = await recover()

    expect(result).toMatchObject({
      deleted: [spoolPath],
      directoryRemoved: true,
      recovered: [],
    })
    expect(await fs.readdir(outputDir)).toEqual([])
    expect(logs).toEqual([])
  })

  it('moves a spool with frames to its frames file and warns', async () => {
    const stream = withFrames()
    await writeSpool(spoolName('checkout', 2), stream)
    await writeSpool(spoolName('checkout', 3), withFrames(32, 3))

    const result = await recover()

    const first = path.join(outputDir, 'checkout_part2.frames.mkv')
    const second = path.join(outputDir, 'checkout_part3.frames.mkv')
    expect(result).toMatchObject({
      deleted: [],
      directoryRemoved: true,
      left: [],
      recovered: [first, second],
    })
    expect(await fs.readFile(first)).toEqual(stream)
    expect((await fs.readdir(outputDir)).sort()).toEqual([
      'checkout_part2.frames.mkv',
      'checkout_part3.frames.mkv',
    ])
    expect(warnings()).toHaveLength(1)
    const [message = ''] = warnings()
    expect(message).toContain('2 recordings')
    expect(message).toContain(
      'checkout_part2.frames.mkv, checkout_part3.frames.mkv',
    )
    expect(message).toContain('last held image')
    expect(message).toContain(
      `ffmpeg -i "${first}" -pix_fmt yuv420p "${path.join(outputDir, 'checkout_part2.converted.webm')}"`,
    )
  })

  it('keeps a spool whose frames are in a structure the writer does not produce', async () => {
    const stream = blockGroupStream(Buffer.alloc(64, 7), TRACK)
    const spoolPath = await writeSpool(spoolName('kept', 1), stream)

    const result = await recover()

    const framesPath = path.join(outputDir, 'kept_part1.frames.mkv')
    expect(result).toMatchObject({
      deleted: [],
      directoryRemoved: true,
      left: [],
      recovered: [framesPath],
    })
    expect(await fs.readFile(framesPath)).toEqual(stream)
    expect(await exists(spoolPath)).toBe(false)
    expect(warnings()).toEqual([
      expect.stringContaining('kept_part1.frames.mkv'),
    ])
    expect(
      logs.some(
        ({ level, message }) =>
          level === 'debug' &&
          message.includes(spoolPath) &&
          message.includes('not one the writer produces'),
      ),
    ).toBe(true)
  })

  it('leaves files it did not name under their own names, with the directory', async () => {
    const unrelated = {
      'checkout_part1.mkv': withFrames(),
      'checkout_part1.not-a-uuid.mkv': headerOnly(),
      'notes.mkv': headerOnly(),
      'video.mkv': withFrames(),
      [`Checkout_part1.${testSpoolUuid()}.mkv`]: headerOnly(),
      [`checkout_part1.${testSpoolUuid()}.frames.mkv`]: headerOnly(),
      [spoolName('checkout', 0)]: headerOnly(),
    }
    for (const [name, content] of Object.entries(unrelated)) {
      await writeSpool(name, content)
    }

    const result = await recover()

    expect(result).toEqual({
      deleted: [],
      directoryRemoved: false,
      left: [],
      recovered: [],
    })
    for (const [name, content] of Object.entries(unrelated)) {
      expect(await fs.readFile(path.join(runDirectory(), name))).toEqual(
        content,
      )
    }
    expect(await fs.readdir(outputDir)).toEqual([SPOOL_DIR_NAME])
    expect(warnings()).toEqual([])
  })

  it('leaves one frames file when a second recovery finds the spool an earlier one linked', async () => {
    const stream = withFrames()
    const spoolPath = await writeSpool(spoolName('retry', 1), stream)
    const unlink = vi.fn(async () => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    })

    const first = await recover({ clock: noDelay, fileSystem: { unlink } })
    const second = await recover()

    const framesPath = path.join(outputDir, 'retry_part1.frames.mkv')
    expect(first?.left).toEqual([
      { path: spoolPath, reason: expect.stringContaining(framesPath) },
    ])
    expect(second).toMatchObject({
      deleted: [],
      directoryRemoved: true,
      left: [],
      recovered: [framesPath],
    })
    expect(await fs.readdir(outputDir)).toEqual(['retry_part1.frames.mkv'])
    expect(await fs.readFile(framesPath)).toEqual(stream)
  })

  it('names one recovered recording in the singular', async () => {
    await writeSpool(spoolName('checkout', 1), withFrames())

    await recover()

    expect(warnings()[0]).toContain('of 1 recording were recovered')
  })

  it('recovers a spool whose first image is far larger than the prefix it reads', async () => {
    const stream = withFrames(300_000, 1)
    await writeSpool(spoolName('big', 1), stream)
    const requested: number[] = []
    const realOpen = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(
      async (...args: Parameters<typeof fs.open>) => {
        const handle = await realOpen(...args)
        const read = handle.read.bind(handle) as (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => Promise<{ bytesRead: number }>
        handle.read = (async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          requested.push(length)
          return read(buffer, offset, length, position)
        }) as typeof handle.read
        return handle
      },
    )

    await recover()

    expect(
      await fs.readFile(path.join(outputDir, 'big_part1.frames.mkv')),
    ).toEqual(stream)
    // Only a bounded prefix was asked for, never the whole file.
    expect(requested).toHaveLength(1)
    expect(requested[0]).toBeLessThan(stream.length / 10)
  })

  it('never replaces a file that already has the frames name', async () => {
    const existing = path.join(outputDir, 'checkout_part1.frames.mkv')
    const existingRun2 = path.join(outputDir, 'checkout_run2_part1.frames.mkv')
    await fs.writeFile(existing, 'an earlier recording')
    await fs.writeFile(existingRun2, 'another earlier recording')
    const stream = withFrames()
    await writeSpool(spoolName('checkout', 1), stream)

    const result = await recover()

    expect(await fs.readFile(existing, 'utf8')).toBe('an earlier recording')
    expect(await fs.readFile(existingRun2, 'utf8')).toBe(
      'another earlier recording',
    )
    const recovered = path.join(outputDir, 'checkout_run3_part1.frames.mkv')
    expect(result?.recovered).toEqual([recovered])
    expect(await fs.readFile(recovered)).toEqual(stream)
  })

  it('leaves a spool that cannot be moved, warns, and keeps the directory', async () => {
    const stream = withFrames()
    const spoolPath = await writeSpool(spoolName('checkout', 1), stream)
    const linkFile = vi.fn(async () => {
      throw Object.assign(new Error('cross-device link not permitted'), {
        code: 'EXDEV',
      })
    })

    const result = await recover({ linkFile })

    expect(result?.directoryRemoved).toBe(false)
    expect(result?.left).toEqual([
      {
        path: spoolPath,
        reason: expect.stringContaining('cross-device link not permitted'),
      },
    ])
    expect(await fs.readFile(spoolPath)).toEqual(stream)
    expect(await exists(spoolRoot())).toBe(true)
    expect(await fs.readdir(outputDir)).toEqual([SPOOL_DIR_NAME])
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain(spoolPath)
    expect(warnings()[0]).toContain('could not be recovered')
  })

  it('moves what it can and leaves only the spool that failed', async () => {
    const good = await writeSpool(spoolName('a', 1), withFrames())
    const bad = await writeSpool(spoolName('b', 1), withFrames())
    const linkFile = vi.fn(async (existing: string, target: string) => {
      if (existing === bad) {
        throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' })
      }
      await fs.link(existing, target)
    })

    const result = await recover({ linkFile })

    expect(result?.recovered).toEqual([
      path.join(outputDir, 'a_part1.frames.mkv'),
    ])
    expect(await exists(good)).toBe(false)
    expect(await exists(bad)).toBe(true)
    expect(result?.directoryRemoved).toBe(false)
    expect(warnings()).toHaveLength(2)
  })

  it('reports a spool whose frames were linked but whose own name stayed', async () => {
    const spoolPath = await writeSpool(spoolName('a', 1), withFrames())
    const unlink = vi.fn(async () => {
      throw Object.assign(new Error('locked'), { code: 'ENOSPC' })
    })

    const result = await recover({ clock: noDelay, fileSystem: { unlink } })

    expect(result?.recovered).toEqual([])
    expect(result?.left).toEqual([
      {
        path: spoolPath,
        reason: expect.stringContaining('a_part1.frames.mkv'),
      },
    ])
    expect(await exists(path.join(outputDir, 'a_part1.frames.mkv'))).toBe(true)
    expect(result?.directoryRemoved).toBe(false)
  })

  it('leaves a frameless spool it cannot delete', async () => {
    const spoolPath = await writeSpool(spoolName('a', 1), headerOnly())
    const unlink = vi.fn(async () => {
      throw Object.assign(new Error('read-only'), { code: 'EROFS' })
    })

    const result = await recover({ clock: noDelay, fileSystem: { unlink } })

    expect(result?.deleted).toEqual([])
    expect(result?.left).toEqual([
      {
        path: spoolPath,
        reason: expect.stringContaining('could not be deleted'),
      },
    ])
    expect(await exists(spoolPath)).toBe(true)
    expect(result?.directoryRemoved).toBe(false)
  })

  it('leaves a spool it cannot read', async () => {
    const spoolPath = await writeSpool(spoolName('a', 1), withFrames())
    vi.spyOn(fs, 'open').mockRejectedValueOnce(new Error('EMFILE: too many'))

    const result = await recover()

    expect(result?.left).toEqual([
      { path: spoolPath, reason: expect.stringContaining('EMFILE') },
    ])
    expect(await exists(spoolPath)).toBe(true)
    expect(await exists(runDirectory())).toBe(true)
  })

  it('leaves files that are not spools and the directory that holds them', async () => {
    const note = await writeSpool('notes.txt', 'keep me')
    const nested = path.join(runDirectory(), 'nested')
    await fs.mkdir(nested)
    const nestedSpool = path.join(nested, spoolName('inner', 1))
    await fs.writeFile(nestedSpool, withFrames())
    await writeSpool(spoolName('a', 1), withFrames())
    // A directory named like a spool is not a regular file either.
    await fs.mkdir(path.join(runDirectory(), spoolName('dir', 1)))

    const result = await recover()

    expect(result).toMatchObject({ directoryRemoved: false, left: [] })
    expect(result?.recovered).toEqual([
      path.join(outputDir, 'a_part1.frames.mkv'),
    ])
    expect(await fs.readFile(note, 'utf8')).toBe('keep me')
    expect(await exists(nestedSpool)).toBe(true)
    expect(await exists(path.join(runDirectory(), spoolName('dir', 1)))).toBe(
      true,
    )
    expect(
      logs.some(
        ({ level, message }) =>
          level === 'debug' && message.includes('not frame spools'),
      ),
    ).toBe(true)
  })

  it('rethrows an unexpected failure to remove the directory after reporting the frames', async () => {
    await writeSpool(spoolName('a', 1), withFrames())
    const removeDirectory = vi.fn(async () => {
      throw Object.assign(new Error('EPERM: operation not permitted'), {
        code: 'EPERM',
      })
    })

    await expect(recover({ removeDirectory })).rejects.toThrow('EPERM')

    expect(warnings()).toHaveLength(1)
    expect(await exists(path.join(outputDir, 'a_part1.frames.mkv'))).toBe(true)
  })

  it('leaves the spool root when something else was added to it', async () => {
    await fs.mkdir(runDirectory(), { recursive: true })
    await fs.writeFile(path.join(spoolRoot(), 'stray.txt'), 'x')

    const result = await recover()

    expect(result?.directoryRemoved).toBe(true)
    expect(await fs.readdir(spoolRoot())).toEqual(['stray.txt'])
  })

  it.each(['', '.', '..', '../sibling', 'a/b', 'a\\b', 'C:\\root'])(
    'refuses the unsafe run ID %j and touches nothing',
    async (runId) => {
      const spoolPath = await writeSpool(spoolName('a', 1), withFrames())

      await expect(recover({ runId })).rejects.toThrow('unsafe')

      expect(await exists(spoolPath)).toBe(true)
      expect(await fs.readdir(outputDir)).toEqual([SPOOL_DIR_NAME])
    },
  )

  it('refuses a run directory that is a link out of the root', async () => {
    const elsewhere = await fs.mkdtemp(
      path.join(os.tmpdir(), 'wdio-spool-elsewhere-'),
    )
    try {
      const victim = path.join(elsewhere, spoolName('a', 1))
      await fs.writeFile(victim, withFrames())
      await fs.mkdir(spoolRoot(), { recursive: true })
      await fs.symlink(elsewhere, runDirectory(), 'junction')

      await expect(recover()).rejects.toThrow('not a plain directory')

      expect(await exists(victim)).toBe(true)
      expect(await fs.readdir(outputDir)).toEqual([SPOOL_DIR_NAME])
    } finally {
      await fs.rm(elsewhere, { force: true, recursive: true })
    }
  })

  it('refuses a spool root that is a link and touches nothing behind it', async () => {
    // Node creates a junction on Windows and a plain symbolic link elsewhere;
    // lstat reports both as a link, not a directory.
    const elsewhere = await fs.mkdtemp(
      path.join(os.tmpdir(), 'wdio-spool-elsewhere-'),
    )
    try {
      const linkedRun = path.join(elsewhere, RUN_ID)
      await fs.mkdir(linkedRun)
      const frameless = path.join(linkedRun, spoolName('a', 1))
      const withImages = path.join(linkedRun, spoolName('b', 1))
      await fs.writeFile(frameless, headerOnly())
      await fs.writeFile(withImages, withFrames())
      await fs.symlink(elsewhere, spoolRoot(), 'junction')
      expect((await fs.lstat(spoolRoot())).isSymbolicLink()).toBe(true)

      await expect(recover()).rejects.toThrow('not a plain directory')

      expect(await fs.readFile(frameless)).toEqual(headerOnly())
      expect(await fs.readFile(withImages)).toEqual(withFrames())
      expect(await fs.readdir(outputDir)).toEqual([SPOOL_DIR_NAME])
      expect(await fs.readdir(elsewhere)).toEqual([RUN_ID])
    } finally {
      await fs.unlink(spoolRoot()).catch(() => undefined)
      await fs.rm(elsewhere, { force: true, recursive: true })
    }
  })

  it('refuses a spool root that is a file', async () => {
    await fs.writeFile(spoolRoot(), 'not a directory')

    await expect(recover()).rejects.toThrow('not a plain directory')

    expect(await fs.readFile(spoolRoot(), 'utf8')).toBe('not a directory')
  })

  it('refuses a run directory that is a file', async () => {
    await fs.mkdir(spoolRoot(), { recursive: true })
    await fs.writeFile(runDirectory(), 'not a directory')

    await expect(recover()).rejects.toThrow('not a plain directory')
  })

  it('reports a run directory it cannot inspect', async () => {
    vi.spyOn(fs, 'lstat').mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    )

    await expect(recover()).rejects.toThrow('EACCES')
  })
})
