import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CDPSession, Page } from 'puppeteer-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClockBoundary } from '../../src/service/boundaries.js'
import {
  recordScreencast,
  type ScreencastRecorder,
} from '../../src/service/screencast-recorder.js'
import {
  SpoolBudget,
  type SpoolLimits,
} from '../../src/service/spool-budget.js'
import {
  type PromotionPlan,
  SpoolPromotion,
} from '../../src/service/spool-promotion.js'
import { createControlledDelays } from '../utils/controlled-delays.js'
import {
  createFakeFfmpegProcess,
  type FakeFfmpegProcess,
} from '../utils/fake-ffmpeg.js'
import { gridFrames } from '../utils/matroska-blocks.js'

// The recorder across a promotion: a real spool file in a temp directory, fake
// FFmpeg processes, and a scripted screencast. A promoted recording must give
// its encoder exactly the stream a live recording gives it.

let directory = ''

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-recorder-promo-'))
})

afterEach(async () => {
  await fs.rm(directory, { force: true, recursive: true })
})

const settle = async (turns = 2): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

const exists = async (filePath: string): Promise<boolean> =>
  fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false)

const label = (text: string): string => Buffer.from(text).toString('base64')

const createSession = () => {
  const session = new EventEmitter() as unknown as CDPSession & {
    emitFrame(text: string, timestamp: number): void
    sent: string[]
  }
  const sent: string[] = []
  Object.assign(session, {
    detach: vi.fn(async () => {}),
    emitFrame: (text: string, timestamp: number) => {
      ;(session as unknown as EventEmitter).emit('Page.screencastFrame', {
        data: label(text),
        metadata: { timestamp },
        sessionId: sent.length + 1,
      })
    },
    send: vi.fn(async (method: string) => {
      sent.push(method)
      if (method === 'Page.startScreencast') {
        session.emitFrame('start', 100)
      }
      return {}
    }),
    sent,
  })
  return session
}

const createPage = (session: CDPSession): Page =>
  ({
    createCDPSession: vi.fn(async () => session),
    evaluate: vi.fn(async () => ({
      devicePixelRatio: 1,
      height: 720,
      width: 1280,
    })),
    setViewport: vi.fn(async () => {}),
    viewport: () => null,
  }) as unknown as Page

// A hold clock the script fires by hand, like the recorder's own tests use.
const createHoldClock = (): ClockBoundary & { tick: () => void } => {
  let tick: (() => void) | undefined
  return {
    clearInterval: () => {},
    clearTimeout: () => {},
    delay: async () => {},
    now: () => 0,
    queueMicrotask,
    setInterval: (callback) => {
      tick = callback
      return {} as NodeJS.Timeout
    },
    setTimeout: () => ({}) as NodeJS.Timeout,
    tick: () => {
      tick?.()
    },
  }
}

const LIMITS: SpoolLimits = {
  promoteBytes: Number.MAX_SAFE_INTEGER,
  hardCapBytes: Number.MAX_SAFE_INTEGER,
  promoteFreeBytes: 0,
  stopFreeBytes: 0,
  freeCheckIntervalBytes: Number.MAX_SAFE_INTEGER,
}

interface RigOptions {
  /** How the recorder's delays end; at once by default. */
  readonly delay?: ClockBoundary['delay']
  /** Free space the budget reads, as the spool volume reports it. */
  readonly freeBytes?: number
  readonly limits?: Partial<SpoolLimits>
  /** Every encoder holds its input still until released. */
  readonly stalled?: boolean
  /** The error the encoder fails to start with. */
  readonly spawnError?: Error
  /** A promotion with no plan: the recorder only ever spools. */
  readonly withoutPlan?: boolean
}

const spoolPath = (): string => path.join(directory, 'spool', 'segment.mkv')
const plannedPath = (): string => path.join(directory, 'segment.webm')

const createRig = async (options: RigOptions = {}) => {
  const session = createSession()
  const clock = {
    ...createHoldClock(),
    ...(options.delay ? { delay: options.delay } : {}),
  }
  let monotonic = 0
  const processes: FakeFfmpegProcess[] = []
  const warnings: string[] = []
  const removed: string[] = []
  const reserved: string[] = []
  const plan: PromotionPlan = {
    ffmpegPath: 'ffmpeg',
    plannedPath: plannedPath(),
    remove: vi.fn(async (filePath: string) => {
      removed.push(filePath)
      await fs.rm(filePath, { force: true })
    }),
    reserveOutput: vi.fn(async (planned: string) => {
      await fs.writeFile(planned, '', { flag: 'wx' })
      reserved.push(planned)
      return planned
    }),
    warn: (message) => {
      warnings.push(message)
    },
  }
  const budget = new SpoolBudget(
    { ...LIMITS, ...options.limits },
    { freeBytes: async () => options.freeBytes ?? Number.MAX_SAFE_INTEGER },
  )
  await fs.mkdir(path.dirname(spoolPath()), { recursive: true })
  const recorder = await recordScreencast(
    createPage(session),
    {
      budget,
      ffmpegPath: 'ffmpeg',
      format: 'webm',
      fps: 10,
      quality: 30,
      scale: 1,
      speed: 1,
      spoolPath: spoolPath(),
      ...(options.withoutPlan ? {} : { promotion: plan }),
    },
    {
      clock,
      monotonicNow: () => monotonic,
      spawnProcess: (_command, args) => {
        const process = createFakeFfmpegProcess(
          args,
          options.spawnError ? { spawnError: options.spawnError } : {},
        )
        if (options.stalled) {
          process.stall()
        }
        processes.push(process)
        return process.child
      },
      terminateProcessTree: async (child) => {
        child.kill()
      },
    },
  )
  return {
    advance: (milliseconds: number) => {
      monotonic += milliseconds
    },
    budget,
    clock,
    frame: (text: string, timestamp: number) => {
      monotonic = (timestamp - 100) * 1_000
      session.emitFrame(text, timestamp)
    },
    plan,
    processes,
    recorder,
    removed,
    reserved,
    session,
    warnings,
  }
}

type Rig = Awaited<ReturnType<typeof createRig>>

/** The frames of a script, then enough quiet seconds to hold the last one. */
const FRAMES: ReadonlyArray<readonly [string, number]> = Array.from(
  { length: 40 },
  (_unused, index): readonly [string, number] => [
    `f${index.toString().padStart(2, '0')}`,
    100 + (index + 1) / 10,
  ],
)

type Driver = Pick<Rig, 'advance' | 'clock' | 'frame'>

/** Frames arriving with no pause for the replay to run. */
const burst = async (
  rig: Driver,
  frames: ReadonlyArray<readonly [string, number]>,
): Promise<void> => {
  for (const [text, timestamp] of frames) {
    rig.frame(text, timestamp)
    await Promise.resolve()
  }
}

const play = async (
  rig: Driver,
  frames: ReadonlyArray<readonly [string, number]>,
): Promise<void> => {
  let held = 0
  for (const [text, timestamp] of frames) {
    rig.frame(text, timestamp)
    await settle()
    // A hold a second, like the recorder's own timer.
    if (Math.floor(timestamp) > held) {
      held = Math.floor(timestamp)
      rig.clock.tick()
    }
  }
}

/** What a live recording gives its encoder for the same script. */
const liveBytes = async (
  frames: ReadonlyArray<readonly [string, number]>,
  drive: (
    rig: Driver,
    frames: ReadonlyArray<readonly [string, number]>,
  ) => Promise<void> = play,
  endAfterMs = 3_000,
): Promise<Buffer> => {
  const session = createSession()
  const clock = createHoldClock()
  let monotonic = 0
  let process: FakeFfmpegProcess | undefined
  const recorder = await recordScreencast(
    createPage(session),
    {
      ffmpegPath: 'ffmpeg',
      format: 'webm',
      fps: 10,
      outputPath: path.join(directory, 'live.webm'),
      quality: 30,
      scale: 1,
      speed: 1,
    },
    {
      clock,
      monotonicNow: () => monotonic,
      // Started when the recorder asks, so its start is reported to it.
      spawnProcess: () => {
        process = createFakeFfmpegProcess()
        return process.child
      },
    },
  )
  const rig = {
    advance: (milliseconds: number) => {
      monotonic += milliseconds
    },
    clock,
    frame: (text: string, timestamp: number) => {
      monotonic = (timestamp - 100) * 1_000
      session.emitFrame(text, timestamp)
    },
  }
  await drive(rig, frames)
  rig.advance(endAfterMs)
  await recorder.stop()
  return process?.bytes() ?? Buffer.alloc(0)
}

const stopAfter = async (rig: Rig, milliseconds = 3_000): Promise<void> => {
  rig.advance(milliseconds)
  await rig.recorder.stop()
}

const switched = async (recorder: ScreencastRecorder): Promise<void> => {
  await vi.waitFor(() => {
    expect(recorder.output.kind).toBe('encoded')
  })
}

const labels = (bytes: Buffer): string[] => {
  const frames = gridFrames(bytes, 10)
  return [...new Set(frames.map((frame) => frame.label))]
}

describe('a recorder across a promotion', () => {
  it('promotes mid-stream and gives its encoder the stream a live recording gives it', async () => {
    const rig = await createRig({ limits: { promoteBytes: 400 } })
    await play(rig, FRAMES.slice(0, 20))
    await switched(rig.recorder)
    await play(rig, FRAMES.slice(20))
    await stopAfter(rig)

    expect(rig.processes).toHaveLength(1)
    const expected = await liveBytes(FRAMES)
    expect(rig.processes[0]?.bytes().equals(expected)).toBe(true)
    expect(rig.processes[0]?.inputEnded()).toBe(true)
    expect(rig.recorder.incompleteReason).toBeUndefined()
    expect(rig.warnings).toEqual([])
    // It is an encoded segment at the reserved path, and its spool is gone.
    expect(rig.recorder.output).toEqual({
      kind: 'encoded',
      outputPath: plannedPath(),
    })
    expect(rig.recorder.ffmpegResult.code).toBe(0)
    expect(await exists(spoolPath())).toBe(false)
    expect(await exists(plannedPath())).toBe(true)
    // Leaving the spool took its bytes out of the recording's total.
    expect(rig.budget.bytes).toBe(0)
  })

  it('promotes during a burst of frames', async () => {
    const rig = await createRig({ limits: { promoteBytes: 300 } })
    // No pause for the replay: frames keep arriving as it catches up.
    await burst(rig, FRAMES)
    await switched(rig.recorder)
    await stopAfter(rig)

    const expected = await liveBytes(FRAMES, burst)
    expect(rig.processes[0]?.bytes().equals(expected)).toBe(true)
    expect(labels(expected)).toContain('f39')
    expect(await exists(spoolPath())).toBe(false)
  })

  it('promotes before the first block when the volume is already short of space', async () => {
    // Below the upper floor, above the lower one: promote at segment start.
    const rig = await createRig({
      freeBytes: 1_000,
      limits: { promoteFreeBytes: 2_000, stopFreeBytes: 500 },
    })
    await switched(rig.recorder)
    await play(rig, FRAMES.slice(0, 10))
    await stopAfter(rig)

    expect(rig.budget.promoted).toBe(true)
    const expected = await liveBytes(FRAMES.slice(0, 10))
    expect(rig.processes[0]?.bytes().equals(expected)).toBe(true)
    expect(rig.recorder.output.kind).toBe('encoded')
    expect(await exists(spoolPath())).toBe(false)
  })

  it('keeps the live encoder bounded by its early-exit reason after the switch', async () => {
    const rig = await createRig({ limits: { promoteBytes: 400 } })
    await play(rig, FRAMES.slice(0, 20))
    await switched(rig.recorder)

    rig.processes[0]?.exit(1)
    await vi.waitFor(() => {
      expect(rig.recorder.incompleteReason).toMatch(
        /^FFmpeg exited with code 1 before the recording was stopped/u,
      )
    })

    expect(rig.session.listenerCount('Page.screencastFrame')).toBe(0)
    await expect(rig.recorder.stop()).resolves.toBeUndefined()
  })

  it('no longer counts the recording against the spool budget once it is live', async () => {
    // Promoted at segment start, before any frame can reach the cap.
    const rig = await createRig({
      freeBytes: 1_000,
      limits: {
        hardCapBytes: 450,
        promoteFreeBytes: 2_000,
        stopFreeBytes: 500,
      },
    })
    await switched(rig.recorder)
    await play(rig, FRAMES)
    await stopAfter(rig)

    // More than the cap's worth of stream went to the encoder, uncapped.
    expect(rig.processes[0]?.bytes().length).toBeGreaterThan(450)
    expect(rig.recorder.incompleteReason).toBeUndefined()
  })
})

describe('a promoted recorder at stop', () => {
  it('waits for a frame on its way and gives it to the encoder that took over', async () => {
    const delays = createControlledDelays()
    const rig = await createRig({
      delay: delays.delay,
      limits: { promoteBytes: 400 },
    })
    await play(rig, FRAMES.slice(0, 20))
    await switched(rig.recorder)
    rig.advance(1_000)
    const stopping = rig.recorder.stop()
    await settle()
    expect(rig.session.sent).not.toContain('Page.stopScreencast')
    expect(delays.requested).toHaveLength(1)

    // Painted after the last scripted frame, delivered during the wait.
    rig.session.emitFrame('tail', 102.5)
    await stopping

    expect(rig.recorder.output.kind).toBe('encoded')
    expect(labels(rig.processes[0]?.bytes() ?? Buffer.alloc(0)).at(-1)).toBe(
      'tail',
    )
    expect(rig.processes[0]?.inputEnded()).toBe(true)
  })
})

describe('a recorder that is stopped during the replay', () => {
  it('cancels the promotion, aborts the encoder, removes its output and keeps a complete spool', async () => {
    const rig = await createRig({
      limits: { promoteBytes: 300 },
      stalled: true,
    })
    await play(rig, FRAMES.slice(0, 20))
    await vi.waitFor(() => {
      expect(rig.processes).toHaveLength(1)
    })
    expect(rig.recorder.output.kind).toBe('spool')

    await stopAfter(rig)

    expect(rig.recorder.output.kind).toBe('spool')
    expect(rig.processes[0]?.kill).toHaveBeenCalled()
    expect(rig.removed).toEqual([plannedPath()])
    expect(await exists(plannedPath())).toBe(false)
    expect(rig.warnings).toEqual([])
    expect(rig.recorder.incompleteReason).toBeUndefined()
    // The spool kept receiving the stream throughout, and is complete: the
    // bytes a live encoder would have been given.
    const expected = await liveBytes(FRAMES.slice(0, 20))
    expect((await fs.readFile(spoolPath())).equals(expected)).toBe(true)
  })

  it('ends the recording correctly on either side of a promotion requested by the last frame', async () => {
    const rig = await createRig({ limits: { promoteBytes: 600 } })
    await play(rig, FRAMES.slice(0, 15))
    // Stop in the turn the threshold is crossed, before any replay can finish.
    const stopping = (async () => {
      rig.frame('last', 102)
      rig.advance(3_000)
      await rig.recorder.stop()
    })()
    await stopping

    expect(['spool', 'encoded']).toContain(rig.recorder.output.kind)
    const bytes =
      rig.recorder.output.kind === 'spool'
        ? await fs.readFile(spoolPath())
        : (rig.processes[0]?.bytes() ?? Buffer.alloc(0))
    const expected = await liveBytes([...FRAMES.slice(0, 15), ['last', 102]])
    expect(bytes.equals(expected)).toBe(true)
    // Either way no output is left behind unless it is the encoded segment.
    expect(await exists(plannedPath())).toBe(
      rig.recorder.output.kind === 'encoded',
    )
  })
})

describe('a recorder whose encoder cannot take over', () => {
  it('keeps spooling with one warning and never tries again', async () => {
    const rig = await createRig({
      limits: { promoteBytes: 300 },
      spawnError: new Error('spawn ffmpeg ENOENT'),
    })
    await play(rig, FRAMES.slice(0, 20))
    await vi.waitFor(() => {
      expect(rig.warnings).toHaveLength(1)
    })
    await play(rig, FRAMES.slice(20))
    await stopAfter(rig)

    expect(rig.processes).toHaveLength(1)
    expect(rig.warnings).toHaveLength(1)
    expect(rig.recorder.output.kind).toBe('spool')
    expect(rig.removed).toEqual([plannedPath()])
    expect(await exists(plannedPath())).toBe(false)
    expect(rig.recorder.incompleteReason).toBeUndefined()
    const expected = await liveBytes(FRAMES)
    expect((await fs.readFile(spoolPath())).equals(expected)).toBe(true)
  })

  it('still ends at the hard cap, with every earlier frame intact', async () => {
    const rig = await createRig({
      limits: { hardCapBytes: 520, promoteBytes: 240 },
      spawnError: new Error('spawn ffmpeg ENOENT'),
    })
    // The first frame crosses the promote threshold; the encoder fails.
    rig.frame('f00', 100.1)
    await vi.waitFor(() => {
      expect(rig.warnings).toHaveLength(1)
    })
    for (const [text, timestamp] of FRAMES.slice(1)) {
      rig.frame(text, timestamp)
      await settle()
      if (rig.recorder.incompleteReason) {
        break
      }
    }
    expect(rig.recorder.incompleteReason).toMatch(/reached the disk limit/u)
    await stopAfter(rig)

    const bytes = await fs.readFile(spoolPath())
    expect(bytes.length).toBeLessThanOrEqual(520)
    expect(rig.processes).toHaveLength(1)
    expect(rig.warnings).toHaveLength(1)
    const shown = labels(bytes)
    expect(shown.slice(0, 3)).toEqual(['start', 'f00', 'f01'])
  })

  it('stays a plain spool without a promotion plan', async () => {
    const rig = await createRig({
      limits: { promoteBytes: 300 },
      withoutPlan: true,
    })
    await play(rig, FRAMES.slice(0, 20))
    await stopAfter(rig)

    expect(rig.processes).toHaveLength(0)
    expect(rig.budget.promoted).toBe(true)
    expect(rig.recorder.output.kind).toBe('spool')
  })

  it('does not stop a promoting segment at the lower free-space floor', async () => {
    const rig = await createRig({
      freeBytes: 100,
      limits: { promoteFreeBytes: 2_000, stopFreeBytes: 500 },
      stalled: true,
    })
    await vi.waitFor(() => {
      expect(rig.processes).toHaveLength(1)
    })
    await play(rig, FRAMES.slice(0, 5))

    // Replaying, not spooling: the promotion is its way out of low space.
    expect(rig.recorder.incompleteReason).toBeUndefined()
    await stopAfter(rig)
    expect(rig.recorder.output.kind).toBe('spool')
  })

  it('stops a segment whose promotion failed when the volume is below the lower floor', async () => {
    const rig = await createRig({
      freeBytes: 100,
      limits: { promoteFreeBytes: 2_000, stopFreeBytes: 500 },
      spawnError: new Error('spawn ffmpeg ENOENT'),
    })
    await vi.waitFor(() => {
      expect(rig.warnings).toHaveLength(1)
    })
    rig.frame('f00', 100.1)
    await settle()

    expect(rig.recorder.incompleteReason).toMatch(/Free disk space/u)
    await stopAfter(rig)
  })
})

describe('a recorder aborted in every promotion state', () => {
  it('aborts while spooling', async () => {
    const rig = await createRig()
    await play(rig, FRAMES.slice(0, 5))

    await rig.recorder.abort()

    expect(rig.processes).toHaveLength(0)
    expect(rig.session.listenerCount('Page.screencastFrame')).toBe(0)
  })

  it('aborts while replaying: the encoder dies, its output goes, the spool stays', async () => {
    const rig = await createRig({
      limits: { promoteBytes: 300 },
      stalled: true,
    })
    await play(rig, FRAMES.slice(0, 20))
    await vi.waitFor(() => {
      expect(rig.processes).toHaveLength(1)
    })

    await rig.recorder.abort()

    expect(rig.processes[0]?.kill).toHaveBeenCalled()
    expect(rig.removed).toEqual([plannedPath()])
    expect(await exists(plannedPath())).toBe(false)
    expect(await exists(spoolPath())).toBe(true)
    expect(rig.recorder.output.kind).toBe('spool')
  })

  it('cancels a replay in the caller’s turn, so output read just before an abort stays true', async () => {
    // The engine reads `output` and then aborts a discarded recording. A
    // replay that switched between the two would leave the promoted file
    // behind while the engine deletes only the spool.
    const rig = await createRig({
      limits: { promoteBytes: 300 },
      stalled: true,
    })
    await play(rig, FRAMES.slice(0, 20))
    await vi.waitFor(() => {
      expect(rig.processes).toHaveLength(1)
    })
    const cancel = vi.spyOn(SpoolPromotion.prototype, 'cancel')
    try {
      const aborting = rig.recorder.abort()
      expect(cancel).toHaveBeenCalledTimes(1)
      await aborting
      expect(rig.recorder.output.kind).toBe('spool')
      expect(await exists(plannedPath())).toBe(false)
    } finally {
      cancel.mockRestore()
    }
  })

  it('aborts when live: the encoder dies and no spool remains', async () => {
    const rig = await createRig({ limits: { promoteBytes: 400 } })
    await play(rig, FRAMES.slice(0, 20))
    await switched(rig.recorder)

    await rig.recorder.abort()

    expect(rig.processes[0]?.kill).toHaveBeenCalled()
    expect(await exists(spoolPath())).toBe(false)
  })

  it('bounds an abort even when the promotion cannot undo itself', async () => {
    vi.useFakeTimers()
    try {
      const rig = await createRig({ limits: { promoteBytes: 300 } })
      // The reservation never completes, as on a hung file system.
      vi.mocked(rig.plan.reserveOutput).mockImplementation(
        () => new Promise<string>(() => {}),
      )
      rig.frame('f00', 100.1)
      await vi.advanceTimersByTimeAsync(1)
      rig.recorder.abort().catch(() => undefined)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(rig.session.listenerCount('Page.screencastFrame')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
