import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type FramesFileMoveOptions,
  moveSpoolToFramesFile,
} from '../../src/service/frames-file.js'

let directory = ''

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-frames-file-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(directory, { force: true, recursive: true })
})

const spoolPath = (): string => path.join(directory, 'spool', 'retry.mkv')
const plannedPath = (): string => path.join(directory, 'retry.webm')

const writeSpool = async (content = 'frames'): Promise<string> => {
  await fs.mkdir(path.dirname(spoolPath()), { recursive: true })
  await fs.writeFile(spoolPath(), content)
  return spoolPath()
}

const unlinkSpool = async (filePath: string): Promise<boolean> => {
  await fs.unlink(filePath)
  return true
}

const move = (overrides: Partial<FramesFileMoveOptions> = {}) =>
  moveSpoolToFramesFile({
    linkFile: fs.link,
    plannedPath: plannedPath(),
    removeSpool: unlinkSpool,
    spoolPath: spoolPath(),
    ...overrides,
  })

const outputFiles = async (): Promise<string[]> =>
  (await fs.readdir(directory)).filter((name) => name !== 'spool').sort()

describe('moveSpoolToFramesFile', () => {
  it('links the spool to its frames name and removes the spool', async () => {
    await writeSpool()

    const moved = await move()

    expect(moved).toEqual({
      framesPath: path.join(directory, 'retry.frames.mkv'),
      spoolRemoved: true,
    })
    expect(await outputFiles()).toEqual(['retry.frames.mkv'])
    await expect(fs.stat(spoolPath())).rejects.toThrow()
  })

  it('reuses its own frames file when an earlier move linked it but kept the spool', async () => {
    await writeSpool()

    const first = await move({ removeSpool: async () => false })
    const second = await move()

    expect(first).toEqual({
      framesPath: path.join(directory, 'retry.frames.mkv'),
      spoolRemoved: false,
    })
    expect(second).toEqual({
      framesPath: path.join(directory, 'retry.frames.mkv'),
      spoolRemoved: true,
    })
    expect(await outputFiles()).toEqual(['retry.frames.mkv'])
    expect(
      await fs.readFile(path.join(directory, 'retry.frames.mkv'), 'utf8'),
    ).toBe('frames')
    await expect(fs.stat(spoolPath())).rejects.toThrow()
  })

  it('moves on to a collision name for a distinct file with the same bytes', async () => {
    await writeSpool('frames')
    const taken = path.join(directory, 'retry.frames.mkv')
    await fs.writeFile(taken, 'frames')

    const moved = await move()

    expect(moved).toEqual({
      framesPath: path.join(directory, 'retry_run2.frames.mkv'),
      spoolRemoved: true,
    })
    expect(await fs.readFile(taken, 'utf8')).toBe('frames')
    expect(await outputFiles()).toEqual([
      'retry.frames.mkv',
      'retry_run2.frames.mkv',
    ])
  })

  it('treats a taken name as a collision when the file system reports no file id', async () => {
    await writeSpool()
    await move({ removeSpool: async () => false })
    const realStat = fs.stat.bind(fs)
    vi.spyOn(fs, 'stat').mockImplementation((async (filePath: string) => {
      const stats = await realStat(filePath, { bigint: true })
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
        ino: 0n,
      })
    }) as unknown as typeof fs.stat)

    const moved = await move()

    expect(moved).toEqual({
      framesPath: path.join(directory, 'retry_run2.frames.mkv'),
      spoolRemoved: true,
    })
  })

  it('treats a taken name it cannot inspect as a collision', async () => {
    await writeSpool()
    await move({ removeSpool: async () => false })
    vi.spyOn(fs, 'stat').mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    )

    const moved = await move()

    expect(moved).toEqual({
      framesPath: path.join(directory, 'retry_run2.frames.mkv'),
      spoolRemoved: true,
    })
  })

  it('keeps the spool when it cannot be linked', async () => {
    await writeSpool()
    const failure = Object.assign(new Error('EXDEV'), { code: 'EXDEV' })

    const moved = await move({
      linkFile: async () => {
        throw failure
      },
    })

    expect(moved).toEqual({ error: failure })
    expect(await fs.readFile(spoolPath(), 'utf8')).toBe('frames')
    expect(await outputFiles()).toEqual([])
  })
})
