import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ClockBoundary,
  nodeFileSystem,
  systemClock,
} from '../../src/service/boundaries.js'
import type { SpooledSegment } from '../../src/service/capture-session.js'
import {
  DEFERRED_ENCODE_LIMITS,
  type DeferredEncodeLimits,
  DeferredEncoder,
  type DeferredEncoderOptions,
  resolveDeferredEncodeBudgetMs,
} from '../../src/service/deferred-encode.js'
import {
  FfmpegProcessRegistry,
  type FfmpegRunResult,
  type RunFfmpegOptions,
} from '../../src/service/ffmpeg-runner.js'
import { FfmpegRuntime } from '../../src/service/ffmpeg-runtime.js'
import type { ServiceLogger } from '../../src/service/logging.js'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import type { PostProcessSlotScheduler } from '../../src/service/recording-slots.js'
import { createControlledClock } from '../utils/controlled-clock.js'

const SETTINGS = {
  canvas: { height: 600, width: 800 },
  format: 'webm' as const,
  quality: 30,
  scale: 1,
}

let outputDir = ''

beforeEach(async () => {
  outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-deferred-encode-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(outputDir, { force: true, recursive: true })
})

const exists = async (filePath: string): Promise<boolean> =>
  fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false)

/** A held, spooled segment with its spool on disk. */
const spooled = async (
  part: number,
  overrides: Partial<SpooledSegment> = {},
): Promise<SpooledSegment> => {
  const spoolPath = path.join(
    outputDir,
    '.wdio-video-spool',
    'run',
    `checkout_part${part.toString()}.uuid.mkv`,
  )
  await fs.mkdir(path.dirname(spoolPath), { recursive: true })
  await fs.writeFile(spoolPath, `frames of part ${part.toString()}`)
  const plannedPath = path.join(
    outputDir,
    `checkout_part${part.toString()}.webm`,
  )
  return {
    capturedSeconds: 2,
    clean: true,
    part,
    segment: {
      outputFormat: 'mp4',
      outputPath: path.join(outputDir, `checkout_part${part.toString()}.mp4`),
      recordingFormat: 'webm',
      recordingPath: plannedPath,
      transcode: true,
      transcodeOptions: { deleteOriginal: true },
    },
    spool: { path: spoolPath, settings: SETTINGS },
    tab: {
      contextId: `tab-${part.toString()}`,
      ordinal: part,
      reason: 'start',
    },
    ...overrides,
  }
}

type RunBehaviour = (
  outputPath: string,
  options: Partial<RunFfmpegOptions>,
) => Promise<FfmpegRunResult | undefined>

const exited = (code: number, diagnostic = ''): FfmpegRunResult => ({
  code,
  diagnostic,
  kind: 'exited',
  signal: null,
})

/** FFmpeg that writes the output it is given, then exits 0. */
const encodes: RunBehaviour = async (outputPath) => {
  await fs.writeFile(outputPath, 'vp9')
  return exited(0)
}

/**
 * A fake FFmpeg runtime: every run follows the next behaviour in the list
 * (the last one repeats). Slots are granted unless `slot` says otherwise.
 */
const createFfmpeg = (
  behaviours: RunBehaviour[] = [encodes],
  slot: 'grant' | 'refuse' = 'grant',
) => {
  const state = { accepting: true }
  const runs: Array<{ args: string[]; signal: AbortSignal | undefined }> = []
  const admissions: Array<{ waitMs: number }> = []
  const port: DeferredEncoderOptions['ffmpeg'] = {
    get isAcceptingWork() {
      return state.accepting
    },
    resolvePath: () => 'ffmpeg',
    run: vi.fn(async (args: string[], _operation: string, overrides = {}) => {
      runs.push({ args, signal: overrides.signal })
      const behaviour =
        behaviours[Math.min(runs.length, behaviours.length) - 1] ?? encodes
      const result = await behaviour(args.at(-1) ?? '', overrides)
      if (result) {
        overrides.onResult?.(result)
      }
      return result?.kind === 'exited' && result.code === 0
    }),
    withPostProcessSlot: vi.fn(async (_operation, task, admission) => {
      if (admission) {
        admissions.push({ waitMs: admission.waitMs })
      }
      if (slot === 'refuse' || !state.accepting || admission?.signal.aborted) {
        return undefined
      }
      return task()
    }) as DeferredEncoderOptions['ffmpeg']['withPostProcessSlot'],
  }
  return { admissions, port, runs, state }
}

const createEncoder = (
  ffmpeg: DeferredEncoderOptions['ffmpeg'],
  overrides: Partial<DeferredEncoderOptions> = {},
) => {
  const logs: Array<{ level: string; message: string }> = []
  const log: ServiceLogger = (level, message) => {
    logs.push({ level, message })
  }
  const encoder = new DeferredEncoder({
    clock: systemClock,
    concurrency: {
      postProcessStartMode: 'blocking',
      postProcessStartTimeoutMs: 2_500,
    },
    ffmpeg,
    fileSystem: nodeFileSystem,
    log,
    ...overrides,
  })
  return { encoder, logs }
}

describe('deferred-encode budget', () => {
  it.each([
    [0, 30_000],
    [10, 30_000],
    [15, 30_000],
    [60, 120_000],
    [150, 300_000],
    [3_600, 300_000],
  ])('gives %is of capture a budget of %ims', (seconds, expected) => {
    expect(resolveDeferredEncodeBudgetMs(seconds)).toBe(expected)
  })

  it('uses injected limits', () => {
    const limits: DeferredEncodeLimits = {
      ...DEFERRED_ENCODE_LIMITS,
      budgetMsPerCapturedSecond: 10,
      maximumBudgetMs: 500,
      minimumBudgetMs: 20,
    }
    expect(resolveDeferredEncodeBudgetMs(1, limits)).toBe(20)
    expect(resolveDeferredEncodeBudgetMs(30, limits)).toBe(300)
    expect(resolveDeferredEncodeBudgetMs(100, limits)).toBe(500)
  })
})

describe('deferred encoder', () => {
  it('encodes a spool to a reserved output in a slot, then deletes the spool', async () => {
    const ffmpeg = createFfmpeg()
    const { encoder, logs } = createEncoder(ffmpeg.port)
    const held = await spooled(1)

    const [result] = await encoder.encodeAll([held], 2)

    expect(result?.outcome).toEqual({
      kind: 'encoded',
      segment: {
        ...held.segment,
        outputPath: path.join(outputDir, 'checkout_part1.mp4'),
        recordingPath: path.join(outputDir, 'checkout_part1.webm'),
      },
    })
    expect(ffmpeg.port.withPostProcessSlot).toHaveBeenCalledOnce()
    const args = ffmpeg.runs[0]?.args ?? []
    expect(args.slice(args.indexOf('-i') - 2, args.indexOf('-i') + 2)).toEqual([
      '-f',
      'matroska',
      '-i',
      path.resolve(held.spool.path),
    ])
    expect(ffmpeg.runs[0]?.signal).toBeInstanceOf(AbortSignal)
    // The 30s per-wait limit, never past the rest of the 30s budget.
    expect(ffmpeg.admissions).toHaveLength(1)
    expect(ffmpeg.admissions[0]?.waitMs).toBeGreaterThan(29_000)
    expect(ffmpeg.admissions[0]?.waitMs).toBeLessThanOrEqual(30_000)
    expect(await exists(held.spool.path)).toBe(false)
    await expect(
      fs.readFile(path.join(outputDir, 'checkout_part1.webm'), 'utf8'),
    ).resolves.toBe('vp9')
    expect(logs.filter(({ level }) => level === 'warn')).toEqual([])
  })

  it('reserves around an existing file rather than replacing it', async () => {
    const ffmpeg = createFfmpeg()
    const { encoder } = createEncoder(ffmpeg.port)
    const held = await spooled(1)
    await fs.writeFile(held.segment.recordingPath, 'another recording')

    const [result] = await encoder.encodeAll([held], 2)

    expect(result?.outcome).toMatchObject({
      kind: 'encoded',
      segment: {
        outputPath: path.join(outputDir, 'checkout_run2_part1.mp4'),
        recordingPath: path.join(outputDir, 'checkout_run2_part1.webm'),
      },
    })
    await expect(fs.readFile(held.segment.recordingPath, 'utf8')).resolves.toBe(
      'another recording',
    )
  })

  it('encodes several spools in part order, one at a time', async () => {
    let running = 0
    let concurrent = 0
    const ffmpeg = createFfmpeg([
      async (outputPath) => {
        running += 1
        concurrent = Math.max(concurrent, running)
        await new Promise((resolve) => setImmediate(resolve))
        await fs.writeFile(outputPath, 'vp9')
        running -= 1
        return exited(0)
      },
    ])
    const { encoder } = createEncoder(ffmpeg.port)
    const segments = [await spooled(1), await spooled(2), await spooled(3)]

    const results = await encoder.encodeAll(segments, 6)

    expect(results.map(({ held }) => held.part)).toEqual([1, 2, 3])
    expect(results.every(({ outcome }) => outcome.kind === 'encoded')).toBe(
      true,
    )
    expect(
      ffmpeg.runs.map(({ args }) => path.basename(args.at(-1) ?? '')),
    ).toEqual([
      'checkout_part1.webm',
      'checkout_part2.webm',
      'checkout_part3.webm',
    ])
    expect(concurrent).toBe(1)
  })

  it.each([['no slot in time (fast-fail or wait limit)', 'refuse']] as const)(
    'keeps the frames when there is %s',
    async (_case, slot) => {
      const ffmpeg = createFfmpeg([encodes], slot)
      const { encoder } = createEncoder(ffmpeg.port)
      const held = await spooled(1)

      const [result] = await encoder.encodeAll([held], 2)

      const framesPath = path.join(outputDir, 'checkout_part1.frames.mkv')
      expect(result?.outcome).toEqual({
        failure: `Segment 1 (tab 1) could not be encoded: no post-processing capacity was available in time. Its frames are kept at ${framesPath}; convert them with: ffmpeg -i "${framesPath}" -pix_fmt yuv420p "${path.join(outputDir, 'checkout_part1.converted.webm')}"`,
        kind: 'kept',
      })
      // Admission is never retried, and no process ran.
      expect(ffmpeg.port.withPostProcessSlot).toHaveBeenCalledOnce()
      expect(ffmpeg.runs).toEqual([])
      await expect(fs.readFile(framesPath, 'utf8')).resolves.toBe(
        'frames of part 1',
      )
      expect(await exists(held.spool.path)).toBe(false)
      // The empty file that reserved the output is removed.
      expect(await exists(held.segment.recordingPath)).toBe(false)
    },
  )

  it('reserves the output only once it holds a slot', async () => {
    const reserveOutput = vi.fn(async (desiredPath: string) => desiredPath)
    const refused = createEncoder(createFfmpeg([encodes], 'refuse').port, {
      reserveOutput,
    })

    await refused.encoder.encodeAll([await spooled(1)], 2)

    expect(reserveOutput).not.toHaveBeenCalled()
  })

  it('bounds the slot wait by a fast-fail start timeout', async () => {
    const ffmpeg = createFfmpeg()
    const { encoder } = createEncoder(ffmpeg.port, {
      concurrency: {
        postProcessStartMode: 'fast-fail',
        postProcessStartTimeoutMs: 900,
      },
    })

    await encoder.encodeAll([await spooled(1)], 2)

    expect(ffmpeg.admissions).toEqual([{ waitMs: 900 }])
  })

  it('retries a spawn failure once, then keeps the frames', async () => {
    const ffmpeg = createFfmpeg([
      async () => ({
        kind: 'spawn-failed',
        message: 'FFmpeg failed to start: ENOENT',
      }),
    ])
    const { encoder } = createEncoder(ffmpeg.port)
    const held = await spooled(1)

    const [result] = await encoder.encodeAll([held], 2)

    expect(ffmpeg.runs).toHaveLength(2)
    expect(result?.outcome).toMatchObject({
      failure: expect.stringContaining(
        'could not be encoded: FFmpeg could not encode the frame spool: FFmpeg failed to start: ENOENT.',
      ),
      kind: 'kept',
    })
    expect(result?.outcome).not.toHaveProperty('partial')
    expect(
      await exists(path.join(outputDir, 'checkout_part1.frames.mkv')),
    ).toBe(true)
  })

  it('retries a non-zero exit with no output once, and keeps a second success', async () => {
    const ffmpeg = createFfmpeg([
      async () => exited(1, 'decoder hiccup'),
      encodes,
    ])
    const { encoder } = createEncoder(ffmpeg.port)
    const held = await spooled(1)

    const [result] = await encoder.encodeAll([held], 2)

    expect(ffmpeg.runs).toHaveLength(2)
    expect(ffmpeg.runs[0]?.args.at(-1)).toBe(ffmpeg.runs[1]?.args.at(-1))
    expect(result?.outcome.kind).toBe('encoded')
    expect(await exists(held.spool.path)).toBe(false)
  })

  it('retries an exit 0 that wrote nothing', async () => {
    const ffmpeg = createFfmpeg([async () => exited(0)])
    const { encoder } = createEncoder(ffmpeg.port)

    const [result] = await encoder.encodeAll([await spooled(1)], 2)

    expect(ffmpeg.runs).toHaveLength(2)
    expect(result?.outcome).toMatchObject({
      failure: expect.stringContaining('FFmpeg wrote an empty file'),
      kind: 'kept',
    })
  })

  it('keeps a timeout before any output as frames, without a retry', async () => {
    const ffmpeg = createFfmpeg([
      async () => ({ kind: 'stopped', reason: 'timeout' }),
    ])
    const { encoder } = createEncoder(ffmpeg.port)
    const held = await spooled(1)

    const [result] = await encoder.encodeAll([held], 2)

    expect(ffmpeg.runs).toHaveLength(1)
    expect(result?.outcome).toMatchObject({
      failure: expect.stringContaining(
        'the encode reached processing.ffmpeg.timeoutMs',
      ),
      kind: 'kept',
    })
    expect(await exists(held.segment.recordingPath)).toBe(false)
  })

  it('keeps partial output as unclean media and the frames, without a retry', async () => {
    const ffmpeg = createFfmpeg([
      async (outputPath) => {
        await fs.writeFile(outputPath, 'half a video')
        return exited(1, 'No space left on device')
      },
    ])
    const { encoder } = createEncoder(ffmpeg.port)
    const held = await spooled(1)

    const [result] = await encoder.encodeAll([held], 2)

    expect(ffmpeg.runs).toHaveLength(1)
    expect(result?.outcome).toMatchObject({
      failure: expect.stringContaining('No space left on device'),
      kind: 'kept',
      partial: {
        outputFormat: 'webm',
        outputPath: held.segment.recordingPath,
        recordingPath: held.segment.recordingPath,
        transcode: false,
      },
    })
    await expect(fs.readFile(held.segment.recordingPath, 'utf8')).resolves.toBe(
      'half a video',
    )
    expect(
      await exists(path.join(outputDir, 'checkout_part1.frames.mkv')),
    ).toBe(true)
  })

  it('retries an output that could not be reserved', async () => {
    const reserveOutput = vi
      .fn<(desiredPath: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('EACCES: permission denied'))
      .mockImplementation(async (desiredPath) => {
        await fs.writeFile(desiredPath, '')
        return desiredPath
      })
    const ffmpeg = createFfmpeg()
    const { encoder } = createEncoder(ffmpeg.port, { reserveOutput })

    const [result] = await encoder.encodeAll([await spooled(1)], 2)

    expect(reserveOutput).toHaveBeenCalledTimes(2)
    expect(ffmpeg.runs).toHaveLength(1)
    expect(result?.outcome.kind).toBe('encoded')
  })

  it('keeps an output error that persists as frames', async () => {
    const reserveOutput = vi.fn(async () => {
      throw new Error('EROFS: read-only file system')
    })
    const ffmpeg = createFfmpeg()
    const { encoder } = createEncoder(ffmpeg.port, { reserveOutput })

    const [result] = await encoder.encodeAll([await spooled(1)], 2)

    expect(reserveOutput).toHaveBeenCalledTimes(2)
    expect(ffmpeg.runs).toEqual([])
    expect(result?.outcome).toMatchObject({
      failure: expect.stringContaining(
        'its output could not be reserved: EROFS: read-only file system',
      ),
      kind: 'kept',
    })
  })

  it('encodes an incomplete capture as unclean media and deletes its spool', async () => {
    const ffmpeg = createFfmpeg()
    const { encoder } = createEncoder(ffmpeg.port)
    const held = await spooled(1, {
      clean: false,
      incompleteReason: 'The frame spool could not be written: ENOSPC',
    })

    const [result] = await encoder.encodeAll([held], 2)

    expect(ffmpeg.runs).toHaveLength(1)
    expect(result?.outcome).toMatchObject({
      failure: expect.stringContaining(
        'its capture was incomplete (The frame spool could not be written: ENOSPC)',
      ),
      kind: 'kept',
      partial: { recordingPath: held.segment.recordingPath, transcode: false },
    })
    expect(
      (result?.outcome as { failure: string } | undefined)?.failure,
    ).not.toContain('frames')
    await expect(fs.readFile(held.segment.recordingPath, 'utf8')).resolves.toBe(
      'vp9',
    )
    expect(await exists(held.spool.path)).toBe(false)
    expect(
      await exists(path.join(outputDir, 'checkout_part1.frames.mkv')),
    ).toBe(false)
  })

  it('keeps the frames of an incomplete capture whose encode failed with partial output', async () => {
    const ffmpeg = createFfmpeg([
      async (outputPath) => {
        await fs.writeFile(outputPath, 'half a video')
        return exited(1, 'No space left on device')
      },
    ])
    const { encoder } = createEncoder(ffmpeg.port)
    const held = await spooled(1, {
      clean: false,
      incompleteReason: 'The frame spool could not be written: ENOSPC',
    })

    const [result] = await encoder.encodeAll([held], 2)

    expect(ffmpeg.runs).toHaveLength(1)
    expect(result?.outcome).toMatchObject({
      failure: expect.stringContaining('No space left on device'),
      kind: 'kept',
      partial: { recordingPath: held.segment.recordingPath, transcode: false },
    })
    expect(
      (result?.outcome as { failure: string } | undefined)?.failure,
    ).toContain('Its frames are kept at')
    expect(await exists(held.spool.path)).toBe(false)
    expect(
      await exists(path.join(outputDir, 'checkout_part1.frames.mkv')),
    ).toBe(true)
  })

  it('stops at shutdown and starts nothing for the spools after it', async () => {
    const ffmpeg = createFfmpeg([
      async () => {
        ffmpeg.state.accepting = false
        return { kind: 'stopped', reason: 'cancelled' }
      },
    ])
    const { encoder } = createEncoder(ffmpeg.port)
    const segments = [await spooled(1), await spooled(2)]

    const results = await encoder.encodeAll(segments, 4)

    expect(ffmpeg.runs).toHaveLength(1)
    expect(results.map(({ outcome }) => outcome.kind)).toEqual(['kept', 'kept'])
    for (const { outcome } of results) {
      expect(outcome).toMatchObject({
        failure: expect.stringContaining(
          'the encode was cancelled at shutdown',
        ),
      })
    }
    expect(ffmpeg.port.withPostProcessSlot).toHaveBeenCalledOnce()
    expect(
      await exists(path.join(outputDir, 'checkout_part2.frames.mkv')),
    ).toBe(true)
  })

  it('shares one budget across spools with slow encoders and starts nothing after it', async () => {
    const limits: DeferredEncodeLimits = {
      budgetMsPerCapturedSecond: 1,
      maximumBudgetMs: 300,
      maximumSlotWaitMs: 30_000,
      minimumBudgetMs: 150,
    }
    const time = createControlledClock()
    // Each encode takes 100ms of the controlled clock unless it is stopped.
    const slow: RunBehaviour = async (outputPath, options) => {
      const stopped = await new Promise<boolean>((resolve) => {
        const timer = time.clock.setTimeout(() => {
          resolve(false)
        }, 100)
        options.signal?.addEventListener('abort', () => {
          time.clock.clearTimeout(timer)
          resolve(true)
        })
      })
      if (stopped) {
        return { kind: 'stopped', reason: 'cancelled' }
      }
      await fs.writeFile(outputPath, 'vp9')
      return exited(0)
    }
    const ffmpeg = createFfmpeg([slow])
    const { encoder } = createEncoder(ffmpeg.port, {
      clock: time.clock,
      limits,
    })
    const segments = [
      await spooled(1),
      await spooled(2),
      await spooled(3),
      await spooled(4),
    ]

    const finished = encoder.encodeAll(segments, 0)
    // The first encode takes its 100ms; the second starts at 100ms and the
    // budget (150ms) runs out 50ms into it.
    await vi.waitFor(() => {
      expect(ffmpeg.runs).toHaveLength(1)
    })
    time.advance(100)
    await vi.waitFor(() => {
      expect(ffmpeg.runs).toHaveLength(2)
    })
    time.advance(50)
    const results = await finished

    expect(time.pendingTimers()).toBe(0)
    expect(results.map(({ outcome }) => outcome.kind)).toEqual([
      'encoded',
      'kept',
      'kept',
      'kept',
    ])
    // The second encode was stopped by the budget; nothing started after it.
    expect(ffmpeg.runs).toHaveLength(2)
    expect(ffmpeg.runs[1]?.signal?.aborted).toBe(true)
    expect(results[1]?.outcome).toMatchObject({
      failure: expect.stringContaining(
        'the deferred-encode budget of 0.15s ran out',
      ),
    })
    expect(ffmpeg.admissions.map(({ waitMs }) => waitMs)).toEqual([150, 50])
    for (const part of [2, 3, 4]) {
      expect(
        await exists(
          path.join(outputDir, `checkout_part${part.toString()}.frames.mkv`),
        ),
      ).toBe(true)
    }
  })

  it('names a frames file around existing files and never replaces one', async () => {
    const ffmpeg = createFfmpeg([encodes], 'refuse')
    const { encoder } = createEncoder(ffmpeg.port)
    const taken = path.join(outputDir, 'checkout_part1.frames.mkv')
    await fs.writeFile(taken, 'older frames')

    const [result] = await encoder.encodeAll([await spooled(1)], 2)

    const framesPath = path.join(outputDir, 'checkout_run2_part1.frames.mkv')
    expect(result?.outcome).toMatchObject({
      failure: expect.stringContaining(`Its frames are kept at ${framesPath};`),
    })
    await expect(fs.readFile(taken, 'utf8')).resolves.toBe('older frames')
    await expect(fs.readFile(framesPath, 'utf8')).resolves.toBe(
      'frames of part 1',
    )
  })

  it('leaves the spool in place, and names it, when it cannot be moved', async () => {
    const linkFile = vi.fn(async () => {
      throw Object.assign(new Error('EPERM: operation not permitted, link'), {
        code: 'EPERM',
      })
    })
    const ffmpeg = createFfmpeg([encodes], 'refuse')
    const { encoder } = createEncoder(ffmpeg.port, { linkFile })
    const held = await spooled(1)

    const [result] = await encoder.encodeAll([held], 2)

    expect(result?.outcome).toMatchObject({
      failure: expect.stringContaining(
        `Its frames could not be moved (EPERM: operation not permitted, link) and stay at ${held.spool.path}; convert them with: ffmpeg -i "${held.spool.path}"`,
      ),
    })
    await expect(fs.readFile(held.spool.path, 'utf8')).resolves.toBe(
      'frames of part 1',
    )
  })

  it('stops looking for a frames name after the candidate limit', async () => {
    const linkFile = vi.fn(async () => {
      throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
    })
    const { encoder } = createEncoder(createFfmpeg().port, { linkFile })
    const held = await spooled(1)

    const text = await encoder.preserveFrames({
      part: 1,
      plannedPath: held.segment.recordingPath,
      spool: held.spool,
    })

    expect(linkFile).toHaveBeenCalledTimes(1_000)
    expect(text).toContain('every candidate name for')
    expect(text).toContain(`stay at ${held.spool.path}`)
  })
})

describe('deferred encoder over the real FFmpeg runtime', () => {
  const createRuntime = (
    acquire: () => Promise<boolean>,
    clock?: ClockBoundary,
  ) => {
    const release = vi.fn(async () => {})
    const runFfmpeg = vi.fn(async (_options: RunFfmpegOptions) => true)
    const runtime = new FfmpegRuntime({
      ...(clock ? { clock } : {}),
      createPostProcessSlotScheduler: () =>
        ({ acquire, release }) as unknown as PostProcessSlotScheduler,
      getCandidates: () => ['ffmpeg'],
      log: () => {},
      options: resolveServiceConfiguration({}).options,
      probeDirectMp4: async () => true,
      process: {
        environment: () => undefined,
        isAlive: () => true,
        pid: 1,
        platform: 'linux',
      },
      processRegistry: new FfmpegProcessRegistry(),
      resolveFfmpeg: async () => ({ path: 'ffmpeg', version: '7.1' }),
      runFfmpeg,
    })
    return { release, runFfmpeg, runtime }
  }

  it('starts no process for a slot granted after the budget ran out, and releases it unused', async () => {
    const grant = Promise.withResolvers<boolean>()
    const time = createControlledClock()
    const { release, runFfmpeg, runtime } = createRuntime(
      () => grant.promise,
      time.clock,
    )
    await runtime.ensureReady()
    const { encoder } = createEncoder(runtime, {
      clock: time.clock,
      limits: {
        budgetMsPerCapturedSecond: 0,
        maximumBudgetMs: 50,
        maximumSlotWaitMs: 30_000,
        minimumBudgetMs: 50,
      },
    })
    const held = await spooled(1)

    const finished = encoder.encodeAll([held], 0)
    // The budget and the slot wait both end at 50ms, in the same advance.
    await vi.waitFor(() => {
      expect(time.pendingTimers()).toBe(2)
    })
    time.advance(50)
    const [result] = await finished

    expect(result?.outcome).toMatchObject({
      failure: expect.stringContaining(
        'the deferred-encode budget of 0.05s ran out',
      ),
      kind: 'kept',
    })
    grant.resolve(true)
    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledOnce()
    })
    expect(runFfmpeg).not.toHaveBeenCalled()
  })

  it('keeps the frames when the processing lease cannot be stored', async () => {
    const { runFfmpeg, runtime } = createRuntime(async () => {
      throw new Error('EACCES: lock directory')
    })
    await runtime.ensureReady()
    const { encoder } = createEncoder(runtime)

    const [result] = await encoder.encodeAll([await spooled(1)], 2)

    expect(result?.outcome).toMatchObject({
      failure: expect.stringContaining(
        'no post-processing capacity was available in time',
      ),
      kind: 'kept',
    })
    expect(runFfmpeg).not.toHaveBeenCalled()
  })

  it('stops an encode in flight at shutdown and keeps its frames', async () => {
    const { runFfmpeg, runtime } = createRuntime(async () => true)
    await runtime.ensureReady()
    runFfmpeg.mockImplementation(async (options: RunFfmpegOptions) => {
      await runtime.terminateAll()
      options.onResult?.({ kind: 'stopped', reason: 'cancelled' })
      return false
    })
    const { encoder } = createEncoder(runtime)
    const segments = [await spooled(1), await spooled(2)]

    const results = await encoder.encodeAll(segments, 4)

    expect(runFfmpeg).toHaveBeenCalledOnce()
    expect(results.map(({ outcome }) => outcome.kind)).toEqual(['kept', 'kept'])
  })
})
