import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EncoderSink } from '../../src/service/frame-sink.js'
import {
  type SpoolFileStream,
  SpoolSink,
} from '../../src/service/frame-sink.js'
import {
  type PromotionPlan,
  SpoolPromotion,
} from '../../src/service/spool-promotion.js'
import {
  createFakeFfmpegProcess,
  type FakeFfmpegProcess,
} from '../utils/fake-ffmpeg.js'

const SETTINGS = {
  canvas: { height: 600, width: 800 },
  format: 'webm' as const,
  quality: 30,
  scale: 1,
}

let directory = ''

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-promotion-'))
})

afterEach(async () => {
  await fs.rm(directory, { force: true, recursive: true })
})

const settle = async (turns = 3): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

const exists = async (filePath: string): Promise<boolean> =>
  fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false)

interface HarnessOptions {
  /** Fails the reservation as a full or read-only disk would. */
  readonly reserveError?: Error
  /** The path the reservation returns, unwritten, instead of the planned one. */
  readonly reservedPath?: string
  readonly openFile?: (filePath: string) => SpoolFileStream
}

const createHarness = (options: HarnessOptions = {}) => {
  const spoolPath = path.join(directory, 'spool', 'segment.mkv')
  const planned = path.join(directory, 'segment.webm')
  const processes: FakeFfmpegProcess[] = []
  const warnings: string[] = []
  const removed: string[] = []
  const switched: EncoderSink[] = []
  // What the encoder had been given, and what the spool still buffered, in
  // the very turn the recorder was handed the encoder.
  const atSwitch: Array<{ buffered: number; encoderBytes: Buffer }> = []
  let spawnFailure: Error | undefined
  let stalled = false
  let spool: SpoolSink | undefined
  const plan: PromotionPlan = {
    ffmpegPath: 'ffmpeg',
    plannedPath: planned,
    remove: vi.fn(async (filePath: string) => {
      removed.push(filePath)
      await fs.rm(filePath, { force: true })
    }),
    reserveOutput: vi.fn(async (plannedPath: string) => {
      if (options.reserveError) {
        throw options.reserveError
      }
      if (options.reservedPath !== undefined) {
        return options.reservedPath
      }
      await fs.writeFile(plannedPath, '', { flag: 'wx' })
      return plannedPath
    }),
    warn: (message) => {
      warnings.push(message)
    },
  }
  const create = async (): Promise<SpoolSink> => {
    await fs.mkdir(path.dirname(spoolPath), { recursive: true })
    spool = new SpoolSink(
      { path: spoolPath, settings: SETTINGS },
      options.openFile ? { openFile: options.openFile } : {},
    )
    await spool.ready
    return spool
  }
  const spawnProcess = vi.fn((_command: string, args: string[]) => {
    const process = createFakeFfmpegProcess(
      args,
      spawnFailure ? { spawnError: spawnFailure } : {},
    )
    if (stalled) {
      process.stall()
    }
    processes.push(process)
    return process.child
  })
  const promotionFor = (sink: SpoolSink): SpoolPromotion =>
    new SpoolPromotion(
      sink,
      plan,
      (encoder) => {
        switched.push(encoder)
        atSwitch.push({
          buffered: sink.bytesBuffered,
          encoderBytes: processes.at(-1)?.bytes() ?? Buffer.alloc(0),
        })
      },
      {
        spawnProcess,
        terminateProcessTree: async (child) => {
          child.kill()
        },
      },
    )
  return {
    atSwitch,
    create,
    failSpawn: (error: Error) => {
      spawnFailure = error
    },
    // Every encoder it starts holds its input still, as a starved one does.
    stallEncoders: () => {
      stalled = true
    },
    started: async (count = 1) => {
      await vi.waitFor(() => {
        expect(processes).toHaveLength(count)
      })
    },
    plan,
    planned,
    processes,
    promotionFor,
    removed,
    spawnProcess,
    spoolPath,
    switched,
    warnings,
  }
}

const waitForState = async (
  promotion: SpoolPromotion,
  state: SpoolPromotion['state'],
): Promise<void> => {
  await vi.waitFor(() => {
    expect(promotion.state).toBe(state)
  })
}

describe('spool promotion replay', () => {
  it('replays the spool into a new encoder and hands the recorder the encoder when caught up', async () => {
    const harness = createHarness()
    const spool = await harness.create()
    spool.write(Buffer.from('header|'))
    spool.write(Buffer.from('block-1|'))
    const promotion = harness.promotionFor(spool)

    expect(promotion.state).toBe('spooling')
    promotion.start()
    expect(promotion.state).toBe('replaying')
    await waitForState(promotion, 'live')

    expect(harness.switched).toHaveLength(1)
    // The same arguments a live segment uses, writing the reserved output.
    const args = harness.processes[0]?.args ?? []
    expect(args.at(-1)).toBe(harness.planned)
    expect(args).toContain('pipe:0')
    // In the turn of the switch: everything on disk was with the encoder and
    // nothing was buffered.
    expect(harness.atSwitch[0]?.buffered).toBe(0)
    expect(harness.atSwitch[0]?.encoderBytes.toString()).toBe('header|block-1|')
    expect(promotion.outputPath).toBe(harness.planned)
    // The spool is closed and deleted.
    await vi.waitFor(async () => {
      expect(await exists(harness.spoolPath)).toBe(false)
    })
    expect(harness.removed).toEqual([harness.spoolPath])
    expect(harness.warnings).toEqual([])
  })

  it.each(['-f/segment_part1.webm', 'ci:1/segment_part1.webm'])(
    'gives the encoder an absolute output path for %s',
    async (reserved) => {
      // FFmpeg reads a name that starts with `-` as an option, and one with a
      // colon as a protocol; neither may reach it relative.
      const harness = createHarness({ reservedPath: reserved })
      const spool = await harness.create()
      spool.write(Buffer.from('header|'))
      const promotion = harness.promotionFor(spool)

      promotion.start()
      await harness.started()

      expect(harness.processes[0]?.args.at(-1)).toBe(path.resolve(reserved))
      await promotion.cancel()
    },
  )

  it('delivers one continuous stream when the recorder keeps appending during the replay', async () => {
    const harness = createHarness()
    const spool = await harness.create()
    const written: Buffer[] = []
    const append = (text: string): void => {
      const chunk = Buffer.from(text)
      written.push(chunk)
      spool.write(chunk)
    }
    append('header|')
    for (let index = 0; index < 20; index += 1) {
      append(`block-${index.toString()}|`)
    }
    const promotion = harness.promotionFor(spool)
    // The encoder is slow: bytes keep reaching the spool while it replays.
    harness.stallEncoders()
    promotion.start()
    await harness.started()
    for (let index = 20; index < 40; index += 1) {
      append(`block-${index.toString()}|`)
      await settle(1)
    }
    expect(promotion.state).toBe('replaying')
    harness.processes[0]?.release()
    // Writes keep arriving as it catches up.
    for (let index = 40; index < 45; index += 1) {
      append(`block-${index.toString()}|`)
    }
    await waitForState(promotion, 'live')

    // After the switch the recorder writes to the encoder.
    const encoder = harness.switched[0]
    for (const text of ['after-1|', 'after-2|']) {
      const chunk = Buffer.from(text)
      written.push(chunk)
      encoder?.write(chunk)
    }
    await settle()

    expect(harness.processes[0]?.bytes().equals(Buffer.concat(written))).toBe(
      true,
    )
    await vi.waitFor(async () => {
      expect(await exists(harness.spoolPath)).toBe(false)
    })
  })

  it('replays a spool larger than one read, in order, under backpressure', async () => {
    const harness = createHarness()
    const spool = await harness.create()
    const big = Buffer.alloc(2.5 * 1024 * 1024)
    for (let index = 0; index < big.length; index += 1) {
      big[index] = index % 251
    }
    spool.write(big)
    const promotion = harness.promotionFor(spool)
    harness.stallEncoders()
    promotion.start()
    await harness.started()
    await settle(5)
    expect(promotion.state).toBe('replaying')
    harness.processes[0]?.release()
    await waitForState(promotion, 'live')

    expect(harness.processes[0]?.bytes().equals(big)).toBe(true)
  })

  it('waits for buffered bytes to reach the disk before it switches', async () => {
    const harness = createHarness()
    const spool = await harness.create()
    const promotion = harness.promotionFor(spool)
    spool.write(Buffer.from('a|'))
    promotion.start()
    for (let index = 0; index < 50; index += 1) {
      spool.write(Buffer.from(`b${index.toString()}|`))
    }
    await waitForState(promotion, 'live')

    // Never switched while anything the recorder had written was still
    // buffered: the encoder has every one of those bytes.
    expect(harness.atSwitch[0]?.buffered).toBe(0)
    expect(harness.atSwitch[0]?.encoderBytes.length).toBe(spool.bytesAccepted)
  })

  it('starts one promotion, with no second attempt', async () => {
    const harness = createHarness()
    const spool = await harness.create()
    spool.write(Buffer.from('x'))
    const promotion = harness.promotionFor(spool)
    promotion.start()
    promotion.start()
    await waitForState(promotion, 'live')
    promotion.start()

    expect(harness.spawnProcess).toHaveBeenCalledOnce()
    expect(harness.plan.reserveOutput).toHaveBeenCalledOnce()
  })
})

describe('spool promotion failure', () => {
  it('keeps spooling with one warning when the encoder cannot start', async () => {
    const harness = createHarness()
    harness.failSpawn(new Error('spawn ffmpeg ENOENT'))
    const spool = await harness.create()
    spool.write(Buffer.from('frames'))
    const promotion = harness.promotionFor(spool)
    promotion.start()
    await waitForState(promotion, 'failed')
    await settle()

    expect(harness.warnings).toHaveLength(1)
    expect(harness.warnings[0]).toContain(harness.planned)
    expect(harness.warnings[0]).toContain('spawn ffmpeg ENOENT')
    expect(harness.warnings[0]).toContain('keep going to the frame spool')
    // The reserved output is removed; the spool is untouched and still taking
    // writes.
    expect(harness.removed).toEqual([harness.planned])
    expect(await exists(harness.planned)).toBe(false)
    expect(harness.switched).toHaveLength(0)
    expect(promotion.outputPath).toBeUndefined()
    expect(spool.write(Buffer.from('more'))).toBe(true)
    await spool.end()
    expect(await fs.readFile(harness.spoolPath, 'utf8')).toBe('framesmore')
    // No second attempt, even when asked again.
    promotion.start()
    await settle()
    expect(harness.spawnProcess).toHaveBeenCalledOnce()
    expect(harness.warnings).toHaveLength(1)
  })

  it('keeps spooling when the encoder exits during the replay', async () => {
    const harness = createHarness()
    const spool = await harness.create()
    spool.write(Buffer.from('frames'))
    const promotion = harness.promotionFor(spool)
    harness.stallEncoders()
    promotion.start()
    await harness.started()
    const process = harness.processes[0]
    spool.write(Buffer.from('later'))
    await settle()
    process?.exit(1)
    await waitForState(promotion, 'failed')

    expect(harness.warnings).toHaveLength(1)
    expect(harness.warnings[0]).toContain('exited with code 1')
    expect(harness.removed).toEqual([harness.planned])
    expect(harness.switched).toHaveLength(0)
    await spool.end()
    expect(await fs.readFile(harness.spoolPath, 'utf8')).toBe(
      'framesl'.concat('ater'),
    )
  })

  it('keeps spooling, reserving nothing to remove, when the output cannot be reserved', async () => {
    const harness = createHarness({
      reserveError: new Error('EACCES: permission denied'),
    })
    const spool = await harness.create()
    spool.write(Buffer.from('frames'))
    const promotion = harness.promotionFor(spool)
    promotion.start()
    await waitForState(promotion, 'failed')

    expect(harness.spawnProcess).not.toHaveBeenCalled()
    expect(harness.removed).toEqual([])
    expect(harness.warnings).toHaveLength(1)
    expect(harness.warnings[0]).toContain('EACCES: permission denied')
  })

  it('fails when the spool closes under the replay', async () => {
    const harness = createHarness()
    const spool = await harness.create()
    spool.write(Buffer.from('frames'))
    const promotion = harness.promotionFor(spool)
    harness.stallEncoders()
    promotion.start()
    await harness.started()
    spool.write(Buffer.from('later'))
    await spool.abort()
    harness.processes[0]?.release()
    await waitForState(promotion, 'failed')

    expect(harness.warnings[0]).toContain('The frame spool')
    expect(harness.switched).toHaveLength(0)
  })

  it('fails with the spool write error when the spool cannot be written', async () => {
    const harness = createHarness()
    const spool = await harness.create()
    const promotion = harness.promotionFor(spool)
    spool.write(Buffer.from('frames'))
    harness.stallEncoders()
    promotion.start()
    await harness.started()
    spool.write(Buffer.from('later'))
    ;(spool as unknown as { onError(error: Error): void }).onError(
      new Error('ENOSPC: no space left on device'),
    )
    harness.processes[0]?.release()
    await waitForState(promotion, 'failed')

    expect(harness.warnings[0]).toContain('ENOSPC')
  })
})

describe('spool promotion cancellation', () => {
  it('aborts the encoder, removes its output and keeps the spool when cancelled during the replay', async () => {
    const harness = createHarness()
    const spool = await harness.create()
    spool.write(Buffer.from('frames'))
    const promotion = harness.promotionFor(spool)
    harness.stallEncoders()
    promotion.start()
    await harness.started()
    const process = harness.processes[0]
    spool.write(Buffer.from('more'))
    await settle()

    await promotion.cancel()

    expect(promotion.state).toBe('cancelled')
    expect(process?.kill).toHaveBeenCalled()
    expect(harness.removed).toEqual([harness.planned])
    expect(await exists(harness.planned)).toBe(false)
    expect(harness.warnings).toEqual([])
    expect(harness.switched).toHaveLength(0)
    // The spool is complete, and ends and keeps its bytes.
    await spool.end()
    expect(await fs.readFile(harness.spoolPath, 'utf8')).toBe('framesmore')
  })

  it('never switches after it has been cancelled, however the replay stands', async () => {
    const harness = createHarness()
    const spool = await harness.create()
    spool.write(Buffer.from('frames'))
    const promotion = harness.promotionFor(spool)
    promotion.start()
    // Cancelled in the same turn it began.
    const cancelling = promotion.cancel()
    await cancelling
    await settle()

    expect(promotion.state).toBe('cancelled')
    expect(harness.switched).toHaveLength(0)
    expect(await exists(harness.planned)).toBe(false)
  })

  it('removes an output reserved just as the promotion is cancelled', async () => {
    const harness = createHarness()
    const spool = await harness.create()
    const promotion = harness.promotionFor(spool)
    let reserve: (() => void) | undefined
    vi.mocked(harness.plan.reserveOutput).mockImplementationOnce(
      async (plannedPath) => {
        await new Promise<void>((resolve) => {
          reserve = resolve
        })
        await fs.writeFile(plannedPath, '', { flag: 'wx' })
        return plannedPath
      },
    )
    promotion.start()
    const cancelling = promotion.cancel()
    reserve?.()
    await cancelling

    expect(harness.spawnProcess).not.toHaveBeenCalled()
    expect(harness.removed).toEqual([harness.planned])
    expect(await exists(harness.planned)).toBe(false)
  })

  it('does not start once cancelled before it began', async () => {
    const harness = createHarness()
    const spool = await harness.create()
    const promotion = harness.promotionFor(spool)

    await promotion.cancel()
    promotion.start()
    await settle()

    expect(promotion.state).toBe('cancelled')
    expect(harness.plan.reserveOutput).not.toHaveBeenCalled()
  })

  it('has nothing to undo once it has switched, and waits for the spool to be gone', async () => {
    const harness = createHarness()
    const spool = await harness.create()
    spool.write(Buffer.from('frames'))
    const promotion = harness.promotionFor(spool)
    promotion.start()
    await waitForState(promotion, 'live')

    await promotion.cancel()

    expect(promotion.state).toBe('live')
    expect(await exists(harness.spoolPath)).toBe(false)
    expect(harness.processes[0]?.kill).not.toHaveBeenCalled()
  })
})

describe('spool promotion ownership', () => {
  // A spool this recording did not create: its open found someone else's file.
  const foreignFile = (
    filePath: string,
  ): { open: (filePath: string) => SpoolFileStream } => {
    return {
      open: () => {
        let written = 0
        const stream = new Writable({
          write(chunk: Buffer, _encoding, callback) {
            void fs.appendFile(filePath, chunk).then(() => {
              written += chunk.length
              callback()
            })
          },
        }) as SpoolFileStream
        Object.defineProperty(stream, 'bytesWritten', { get: () => written })
        return stream
      },
    }
  }

  it('never deletes a spool its own exclusive open did not create', async () => {
    const harness = createHarness()
    await fs.mkdir(path.dirname(harness.spoolPath), { recursive: true })
    const foreign = foreignFile(harness.spoolPath)
    const spool = new SpoolSink(
      { path: harness.spoolPath, settings: SETTINGS },
      { openFile: foreign.open },
    )
    await spool.ready
    spool.write(Buffer.from('frames'))
    const promotion = harness.promotionFor(spool)
    promotion.start()
    await waitForState(promotion, 'live')
    await settle(5)

    expect(spool.created).toBe(false)
    expect(await fs.readFile(harness.spoolPath, 'utf8')).toBe('frames')
    expect(harness.removed).toEqual([])
  })
})
