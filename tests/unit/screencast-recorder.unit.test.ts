import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { CDPSession, Page, Viewport } from 'puppeteer-core'
import { describe, expect, it, vi } from 'vitest'
import {
  type ClockBoundary,
  systemClock,
} from '../../src/service/boundaries.js'
import { RECORDER_STOP_TIMEOUT_MS } from '../../src/service/constants.js'
import {
  EncoderSink,
  type SpoolFileStream,
} from '../../src/service/frame-sink.js'
import { createFfmpegArguments } from '../../src/service/screencast-arguments.js'
import {
  recordScreencast,
  resolveCaptureCanvas,
  type ScreencastCaptureOptions,
  ScreencastRecorder,
  type ScreencastRecorderOptions,
  TAIL_FRAME_QUIET_MS,
  TAIL_FRAME_WAIT_MS,
} from '../../src/service/screencast-recorder.js'
import {
  SpoolBudget,
  type SpoolLimits,
} from '../../src/service/spool-budget.js'
import { createControlledDelays } from '../utils/controlled-delays.js'
import {
  type GridFrame,
  gridFrames,
  parseMatroskaStream,
  spanCounts,
} from '../utils/matroska-blocks.js'

const options: ScreencastRecorderOptions = {
  ffmpegPath: 'ffmpeg',
  format: 'webm',
  fps: 30,
  outputPath: 'segment.webm',
  quality: 30,
  scale: 1,
  speed: 1,
}

const frameData = (label: string): string =>
  Buffer.from(label).toString('base64')

type FakeFfmpeg = {
  child: ChildProcess
  /** Everything written to FFmpeg's input. */
  bytes: () => Buffer
  /** Frames written to FFmpeg, as labels at grid positions. */
  frames: (fps?: number) => GridFrame[]
  kill: ReturnType<typeof vi.fn>
  spawn: () => ChildProcess
}

const describeInput = (
  chunks: Buffer[],
): Pick<FakeFfmpeg, 'bytes' | 'frames'> => ({
  bytes: () => Buffer.concat(chunks),
  frames: (fps = 30) => gridFrames(Buffer.concat(chunks), fps),
})

// Grid positions in order, each labelled with the frame shown there, as a
// finished recording plays: every frame lasts until the next.
const shown = (frames: GridFrame[]): string[] => {
  return frames.flatMap((frame, index) => {
    const next = frames[index + 1]
    return Array.from(
      { length: next ? next.position - frame.position : 1 },
      () => frame.label,
    )
  })
}

const createFakeFfmpeg = (
  closeOnEnd = true,
  highWaterMark?: number,
): FakeFfmpeg => {
  const chunks: Buffer[] = []
  const child = new EventEmitter() as ChildProcess & {
    exitCode: number | null
    signalCode: NodeJS.Signals | null
  }
  const stderr = new PassThrough()
  const stdin = new Writable({
    ...(highWaterMark === undefined ? {} : { highWaterMark }),
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  let closing = false
  // Like a real process, the exit is reported a turn after input ends.
  const close = (): void => {
    if (closing) {
      return
    }
    closing = true
    setImmediate(() => {
      child.exitCode ??= 0
      child.emit('close', child.exitCode)
    })
  }
  if (closeOnEnd) {
    stdin.on('finish', close)
  }
  const kill = vi.fn(() => {
    close()
    return true
  })
  Object.assign(child, {
    exitCode: null,
    kill,
    signalCode: null,
    stderr,
    stdin,
    // FFmpeg writes the segment file itself; its output is not piped.
    stdout: null,
    unref: vi.fn(),
  })
  // Like child_process.spawn, report the start after the process is created.
  const spawn = (): ChildProcess => {
    queueMicrotask(() => child.emit('spawn'))
    return child
  }
  return { child, ...describeInput(chunks), kill, spawn }
}

type FakeSession = CDPSession & {
  emitFrame(label: string, timestamp?: unknown): void
  sent: string[]
}

const createFakeSession = (
  onSend: (method: string, session: FakeSession) => void = () => {},
): FakeSession => {
  const session = new EventEmitter() as unknown as FakeSession
  const sent: string[] = []
  Object.assign(session, {
    detach: vi.fn(async () => {}),
    emitFrame: (label: string, timestamp?: unknown) => {
      // Raw protocol events: tests also send malformed timestamps.
      ;(session as unknown as EventEmitter).emit('Page.screencastFrame', {
        data: frameData(label),
        metadata: timestamp === undefined ? {} : { timestamp },
        sessionId: sent.length + 1,
      })
    },
    send: vi.fn(async (method: string) => {
      sent.push(method)
      onSend(method, session)
      return {}
    }),
    sent,
  })
  return session
}

const createPage = (
  session: CDPSession,
  overrides: Partial<{
    devicePixelRatio: number
    height: number
    viewport: Viewport | null
    width: number
  }> = {},
): Page & { setViewport: ReturnType<typeof vi.fn> } => {
  const devicePixelRatio = overrides.devicePixelRatio ?? 1
  return {
    createCDPSession: vi.fn(async () => session),
    evaluate: vi.fn(async () => ({
      devicePixelRatio,
      height: (overrides.height ?? 720) * devicePixelRatio,
      width: (overrides.width ?? 1280) * devicePixelRatio,
    })),
    setViewport: vi.fn(async () => {}),
    viewport: () => overrides.viewport ?? null,
  } as unknown as Page & { setViewport: ReturnType<typeof vi.fn> }
}

const createClock = (): ClockBoundary & { expire: () => void } => {
  let pending: (() => void) | undefined
  return {
    clearInterval: () => {},
    clearTimeout: () => {
      pending = undefined
    },
    delay: async () => {},
    expire: () => {
      pending?.()
    },
    now: () => 0,
    queueMicrotask,
    setInterval: () => ({}) as NodeJS.Timeout,
    setTimeout: (callback) => {
      pending = callback
      return {} as NodeJS.Timeout
    },
  }
}

// A first-frame clock whose repeating hold timer the test fires by hand.
const createHoldClock = (): ClockBoundary & {
  cleared: () => boolean
  interval: () => number | undefined
  tick: () => void
} => {
  let tick: (() => void) | undefined
  let interval: number | undefined
  let cleared = false
  return {
    ...createClock(),
    clearInterval: () => {
      cleared = true
    },
    cleared: () => cleared,
    interval: () => interval,
    setInterval: (callback, milliseconds) => {
      tick = callback
      interval = milliseconds
      return {} as NodeJS.Timeout
    },
    tick: () => {
      tick?.()
    },
  }
}

// Starts a recorder whose screencast delivers frame "start" at `timestamp` as
// soon as it starts, with a controllable monotonic clock in milliseconds.
const startRecorder = async (
  recorderOptions: Partial<ScreencastRecorderOptions> = {},
  startTimestamp = 100,
  ffmpeg: FakeFfmpeg = createFakeFfmpeg(),
  clock: ClockBoundary = createClock(),
  queueLimits?: { maxPendingBytes?: number; maxPendingBlocks?: number },
) => {
  const session = createFakeSession((method, current) => {
    if (method === 'Page.startScreencast') {
      current.emitFrame('start', startTimestamp)
    }
  })
  let monotonic = 0
  const recorder = await recordScreencast(
    createPage(session),
    { ...options, ...recorderOptions },
    {
      clock,
      monotonicNow: () => monotonic,
      spawnProcess: ffmpeg.spawn,
      ...(queueLimits ? { queueLimits } : {}),
    },
  )

  return {
    ...ffmpeg,
    advance: (milliseconds: number) => {
      monotonic += milliseconds
    },
    // Deliver a frame that arrives when its timestamp says it was painted.
    frame: (label: string, timestamp: number) => {
      monotonic = (timestamp - startTimestamp) * 1_000
      session.emitFrame(label, timestamp)
    },
    recorder,
    session,
  }
}

const createRecorder = (ffmpeg: FakeFfmpeg, session: CDPSession) => {
  return ScreencastRecorder.create({
    canvas: { width: 1280, height: 720 },
    sink: new EncoderSink(ffmpeg.child),
    fps: 30,
    monotonicNow: () => 0,
    session,
  })
}

describe('screencast recorder FFmpeg arguments', () => {
  it('reads timestamped frames and keeps probing intact', () => {
    const args = createFfmpegArguments(
      options,
      { width: 1280, height: 720 },
      undefined,
    )
    // Each frame arrives once with its grid timestamp; FFmpeg must not assume
    // a constant input rate.
    expect(args.slice(args.indexOf('-f'), args.indexOf('-i') + 2)).toEqual([
      '-f',
      'matroska',
      '-i',
      'pipe:0',
    ])
    expect(args).not.toContain('-framerate')
    // Unbuffered input or a tiny probe makes FFmpeg lose the first frames.
    for (const flag of [
      '-avioflags',
      '-probesize',
      '-fpsprobesize',
      '-analyzeduration',
      '-fflags',
    ]) {
      expect(args).not.toContain(flag)
    }
    // WebM keeps each frame's timestamp by default: no sync flag, which would
    // be spelled differently across FFmpeg versions.
    expect(args).not.toContain('-fps_mode')
    expect(args).not.toContain('-vsync')
    expect(args.slice(args.indexOf('-f', args.indexOf('-i')))).toEqual(
      expect.arrayContaining(['-f', 'webm']),
    )
  })

  it('writes the segment file itself, replacing its reserved placeholder', () => {
    const args = createFfmpegArguments(
      options,
      { width: 1280, height: 720 },
      undefined,
    )
    // A pipe cannot be seeked, so a WebM written to one has no duration and
    // no seek index. The reserved empty file is overwritten.
    expect(args.slice(-2)).toEqual(['-y', 'segment.webm'])
    expect(args).not.toContain('pipe:1')
    // Short clusters, flushed as they are written, keep what a killed
    // encoder leaves behind decodable up to its last second.
    const output = args.slice(args.indexOf('-f', args.indexOf('-i')))
    expect(output.slice(0, 6)).toEqual([
      '-f',
      'webm',
      '-cluster_time_limit',
      '1000',
      '-flush_packets',
      '1',
    ])
  })

  it('keeps the Matroska cluster flags out of direct MP4 output', () => {
    const args = createFfmpegArguments(
      { ...options, format: 'mp4', outputPath: 'segment.mp4' },
      { width: 1280, height: 720 },
      undefined,
    )
    expect(args.slice(-2)).toEqual(['-y', 'segment.mp4'])
    expect(args).not.toContain('-cluster_time_limit')
    expect(args).not.toContain('-flush_packets')
  })

  it('applies crop and scale in the same filter order as Puppeteer', () => {
    const args = createFfmpegArguments(
      { ...options, format: 'mp4', scale: 0.5 },
      { width: 1600, height: 900 },
      { x: 20, y: 40, width: 800, height: 400 },
    )
    // Speed is applied to frame timestamps, so FFmpeg does no retiming.
    expect(args[args.indexOf('-vf') + 1]).toBe(
      "crop='min(1600,iw):min(900,ih):0:0',pad=1600:900:0:0,crop=800:400:20:40,scale=iw*0.5:-1:flags=lanczos,format=yuv420p",
    )
    expect(args).toEqual(
      expect.arrayContaining(['-movflags', 'hybrid_fragmented']),
    )
    // Direct MP4 would otherwise repeat frames onto a constant rate.
    expect(args).toEqual(expect.arrayContaining(['-fps_mode', 'passthrough']))
    expect(args[args.indexOf('-f', args.indexOf('-i')) + 1]).toBe('mp4')
  })

  it('omits the scale filter when it is not set', () => {
    const args = createFfmpegArguments(
      { format: 'webm', outputPath: 'segment.webm', quality: 30 },
      { width: 1280, height: 720 },
      undefined,
    )
    expect(args[args.indexOf('-vf') + 1]).toBe(
      "crop='min(1280,iw):min(720,ih):0:0',pad=1280:720:0:0,format=yuv420p",
    )
  })

  it('omits the scale filter at its resolved neutral default', () => {
    // `resolveOptions` always supplies `scale: 1`, so this is what an
    // unconfigured recording actually passes. It is truthy, and emitting it
    // cost every default recording a Lanczos resample that produced the frame
    // it already had.
    const args = createFfmpegArguments(
      { format: 'webm', outputPath: 'segment.webm', quality: 30, scale: 1 },
      { width: 1280, height: 720 },
      undefined,
    )
    expect(args[args.indexOf('-vf') + 1]).toBe(
      "crop='min(1280,iw):min(720,ih):0:0',pad=1280:720:0:0,format=yuv420p",
    )
  })

  it('encodes widely playable 4:2:0 video rather than planar RGB', () => {
    const args = createFfmpegArguments(
      options,
      { width: 10, height: 10 },
      undefined,
    )
    // Without it, RGB screenshots select VP9 profile 1 (gbrp): larger, and
    // not decodable by Safari or hardware decoders.
    expect(args[args.indexOf('-vf') + 1]?.endsWith(',format=yuv420p')).toBe(
      true,
    )
  })

  it('encodes at the fastest realtime VP9 speed on every host', () => {
    const args = createFfmpegArguments(
      options,
      { width: 10, height: 10 },
      undefined,
    )
    // A speed derived from the CPU count fell behind real time on small hosts.
    expect(
      args.slice(args.indexOf('-deadline'), args.indexOf('-cpu-used') + 2),
    ).toEqual(['-deadline', 'realtime', '-cpu-used', '8'])
  })

  it('emits each frame as it is encoded, with no lookahead', () => {
    const args = createFfmpegArguments(
      options,
      { width: 10, height: 10 },
      undefined,
    )
    // A lookahead holds frames back until stop, which then waits for them.
    expect(args[args.indexOf('-lag-in-frames') + 1]).toBe('0')
  })
})

describe('screencast capture bounds', () => {
  it('preserves the original dimensions when a ratio cannot be computed', () => {
    expect(
      resolveCaptureCanvas({ width: Number.NaN, height: 600 }, 480, undefined),
    ).toEqual({ width: Number.NaN, height: 600 })
  })

  it('leaves a frame already inside the bound untouched', () => {
    const native = { width: 1280, height: 720 }
    expect(resolveCaptureCanvas(native, 1920, undefined)).toEqual({
      width: 1280,
      height: 720,
    })
    expect(resolveCaptureCanvas(native, undefined, undefined)).toEqual({
      width: 1280,
      height: 720,
    })
  })

  it('shrinks to fit the bound while preserving aspect ratio', () => {
    // Chrome scales a frame down to fit inside the box and never enlarges one.
    expect(
      resolveCaptureCanvas({ width: 1920, height: 1080 }, 1280, undefined),
    ).toEqual({ width: 1280, height: 720 })
    // The tighter of the two bounds wins.
    expect(
      resolveCaptureCanvas({ width: 1920, height: 1080 }, 1280, 360),
    ).toEqual({ width: 640, height: 360 })
  })

  it('rounds the canvas to even pixels', () => {
    // Odd dimensions force the encoder to pad every frame.
    const canvas = resolveCaptureCanvas(
      { width: 1000, height: 667 },
      501,
      undefined,
    )
    expect(canvas.width % 2).toBe(0)
    expect(canvas.height % 2).toBe(0)
  })

  it('asks Chrome for the bound and encodes against the smaller canvas', async () => {
    const ffmpeg = createFakeFfmpeg()
    const session = createFakeSession((method, current) => {
      if (method === 'Page.startScreencast') {
        current.emitFrame('start', 100)
      }
    })
    const spawnProcess = vi.fn((_command: string, _args: string[]) =>
      ffmpeg.spawn(),
    )
    await recordScreencast(
      createPage(session, { width: 1920, height: 1080 }),
      { ...options, maxWidth: 1280 },
      { clock: createClock(), monotonicNow: () => 0, spawnProcess },
    )

    // Chrome composites and encodes the smaller frame, so the saving lands in
    // the browser and on the wire, not only in FFmpeg.
    expect(session.send).toHaveBeenCalledWith('Page.startScreencast', {
      format: 'png',
      maxWidth: 1280,
    })
    // FFmpeg is told to expect the bounded canvas.
    expect(parseMatroskaStream(ffmpeg.bytes()).track).toMatchObject({
      height: 720,
      width: 1280,
    })
    const args = spawnProcess.mock.calls[0]?.[1] ?? []
    expect(args[args.indexOf('-vf') + 1]).toBe(
      "crop='min(1280,iw):min(720,ih):0:0',pad=1280:720:0:0,format=yuv420p",
    )
  })
})

describe('screencast recorder frame decoding', () => {
  it('decodes a frame only when it is written', async () => {
    const ffmpeg = createFakeFfmpeg()
    const decode = vi.spyOn(Buffer, 'from')
    try {
      const run = await startRecorder({ fps: 1 }, 100, ffmpeg)
      decode.mockClear()

      // At 1 fps these all land on grid position 0, so every one of them is
      // superseded before the timeline advances and none is ever written.
      run.frame('skipped-a', 100.1)
      run.frame('skipped-b', 100.2)
      run.frame('skipped-c', 100.3)

      expect(ffmpeg.frames(1)).toEqual([])
      const decodedBase64 = (
        decode.mock.calls as unknown as unknown[][]
      ).filter((call) => call[1] === 'base64')
      expect(decodedBase64).toEqual([])
    } finally {
      decode.mockRestore()
    }
  })

  it('describes the PNG track and the grid rate to FFmpeg before any frame', async () => {
    const harness = await startRecorder({ fps: 24 }, 100)
    const stream = parseMatroskaStream(harness.bytes())
    expect(stream.timestampScale).toBe(1_000_000)
    expect(stream.track).toMatchObject({
      codecId: 'V_MS/VFW/FOURCC',
      // One grid step: the length a player gives the final frame.
      defaultDurationNs: 41_666_667,
      height: 720,
      width: 1280,
    })
    expect(stream.track?.codecPrivate?.toString('ascii', 16, 20)).toBe('MPNG')
    expect(stream.frames).toEqual([])
  })
})

// An encoder that accepts nothing until released. Every `write` call is
// recorded, including the ones Node buffers rather than handing to `_write`.
// A one-byte high-water mark makes every write report backpressure.
const createStalledFfmpeg = (): FakeFfmpeg & {
  release: () => void
} => {
  const chunks: Buffer[] = []
  const pending: Array<() => void> = []
  let flowing = false
  const child = new EventEmitter() as ChildProcess & {
    exitCode: number | null
    signalCode: NodeJS.Signals | null
  }
  const stderr = new PassThrough()
  const stdin = new Writable({
    highWaterMark: 1,
    write(_chunk: Buffer, _encoding, callback) {
      if (flowing) {
        callback()
        return
      }
      pending.push(callback)
    },
  })
  const originalWrite = stdin.write.bind(stdin)
  stdin.write = ((chunk: Buffer) => {
    chunks.push(Buffer.from(chunk))
    return originalWrite(chunk)
  }) as typeof stdin.write
  let closing = false
  const close = (): void => {
    if (closing) {
      return
    }
    closing = true
    setImmediate(() => {
      child.exitCode = 0
      child.emit('close', 0)
    })
  }
  stdin.on('finish', close)
  const kill = vi.fn(() => {
    close()
    return true
  })
  Object.assign(child, {
    exitCode: null,
    kill,
    signalCode: null,
    stderr,
    stdin,
    // FFmpeg writes the segment file itself; its output is not piped.
    stdout: null,
    unref: vi.fn(),
  })
  return {
    child,
    ...describeInput(chunks),
    kill,
    release: () => {
      flowing = true
      while (pending.length > 0) {
        pending.shift()?.()
      }
    },
    spawn: (): ChildProcess => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
  }
}

const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve))

describe('screencast recorder timeline under a stalled encoder', () => {
  it('keeps each frame on its own span when the encoder blocks and recovers', async () => {
    // An earlier attempt at bounding the encoder queue stopped advancing the
    // timeline when the queue grew, then backfilled the missed span with
    // whichever frame arrived next. A two second state showed for a tenth of a
    // second and its replacement appeared nearly two seconds early, while the
    // frame total still looked right. Assert the spans, not the totals.
    const ffmpeg = createStalledFfmpeg()
    const run = await startRecorder({ fps: 30 }, 100, ffmpeg)

    run.frame('second', 102)
    run.frame('third', 103)
    // The first block reached the stalled input; the next waits for it to drain.
    expect(ffmpeg.frames()).toEqual([{ label: 'start', position: 0 }])
    expect(run.recorder.queueStats.pendingBlocks).toBe(1)

    ffmpeg.release()
    await settle()
    expect(ffmpeg.frames()).toEqual([
      { label: 'start', position: 0 },
      { label: 'second', position: 60 },
    ])

    run.advance(1_000)
    await run.recorder.stop()
    expect(spanCounts(ffmpeg.frames())).toEqual({
      start: 60,
      second: 30,
      third: 30,
    })
  })

  it('waits for the encoder to drain instead of buffering every frame', async () => {
    const ffmpeg = createStalledFfmpeg()
    const clock = createHoldClock()
    const run = await startRecorder({ fps: 10 }, 100, ffmpeg, clock)
    for (let second = 1; second <= 30; second += 1) {
      run.frame(`f${second.toString()}`, 100 + second)
      clock.tick()
    }
    // Only the first block reached the stalled input; the rest wait in the
    // bounded queue rather than in Node's writable buffer.
    const input = run.child.stdin as NonNullable<ChildProcess['stdin']>
    expect(input.writableLength).toBeLessThan(1_024)
    expect(run.recorder.queueStats.pendingBlocks).toBe(29)

    ffmpeg.release()
    run.advance(1_000)
    await run.recorder.stop()
    expect(shown(ffmpeg.frames(10))).toEqual([
      ...Array.from({ length: 10 }, () => 'start'),
      ...Array.from({ length: 30 }, (_, index) =>
        Array.from({ length: 10 }, () => `f${(index + 1).toString()}`),
      ).flat(),
    ])
    expect(run.recorder.queueStats).toMatchObject({
      pendingBlocks: 0,
      pendingBytes: 0,
    })
  })

  it('yields to the event loop between long runs of accepted writes', async () => {
    const ffmpeg = createStalledFfmpeg()
    const harness = await startRecorder({ fps: 30 }, 100, ffmpeg)
    for (let frame = 1; frame <= 100; frame += 1) {
      harness.frame(`f${frame.toString()}`, 100 + frame / 30)
    }
    expect(harness.recorder.queueStats.pendingBlocks).toBe(99)
    const immediate = vi.spyOn(globalThis, 'setImmediate')
    try {
      // Once the encoder catches up, the backlog is written in batches.
      ffmpeg.release()
      await harness.recorder.stop()
      expect(harness.frames()).toHaveLength(101)
      expect(immediate.mock.calls.length).toBeGreaterThanOrEqual(3)
    } finally {
      immediate.mockRestore()
    }
  })
})

describe('screencast recorder overload', () => {
  it('stops capturing once waiting frames would exceed the memory limit', async () => {
    const ffmpeg = createStalledFfmpeg()
    const clock = createHoldClock()
    // A held frame costs its 12 base64 characters; a queued one, its 8
    // decoded bytes.
    const run = await startRecorder({ fps: 10 }, 100, ffmpeg, clock, {
      maxPendingBytes: 27,
    })
    run.frame('one-0001', 101)
    run.frame('two-0002', 102)
    expect(run.recorder.incompleteReason).toBeUndefined()
    // Two queued frames and this held one would be 28 bytes.
    run.frame('thr-0003', 103)

    expect(run.recorder.incompleteReason).toBe(
      'The encoder fell behind the screencast (28 bytes of frames waiting for the encoder exceeds 27 bytes); capture stopped after 3.0s to bound memory.',
    )
    expect(run.session.listenerCount('Page.screencastFrame')).toBe(0)
    expect(run.session.sent).toContain('Page.stopScreencast')
    expect(clock.cleared()).toBe(true)
    run.frame('late-0004', 104)
    expect(run.recorder.frameCount).toBe(4)

    // Frames already accepted are still written, and the recording ends where
    // the rejected frame would have started.
    ffmpeg.release()
    run.advance(5_000)
    await run.recorder.stop()
    expect(spanCounts(ffmpeg.frames(10))).toEqual({
      'one-0001': 10,
      start: 10,
      'two-0002': 10,
    })
  })

  it.each([false, true])(
    'stops capturing before a frame whose block would not fit (holds=%s)',
    async (holds) => {
      const ffmpeg = createStalledFfmpeg()
      const clock = createHoldClock()
      const run = await startRecorder({ fps: 10 }, 100, ffmpeg, clock, {
        maxPendingBlocks: 2,
      })
      // With holds, each frame's block is queued by a hold rather than by the
      // next frame's arrival, which then adds none.
      const hold = (): void => {
        if (holds) {
          run.advance(600)
          clock.tick()
        }
      }
      run.frame('a', 101)
      hold()
      run.frame('b', 102)
      hold()
      expect(run.recorder.incompleteReason).toBeUndefined()
      run.frame('c', 103)

      expect(run.recorder.incompleteReason).toBe(
        'The encoder fell behind the screencast (2 frames waiting for the encoder reached the limit of 2); capture stopped after 3.0s to bound memory.',
      )
      // The limit held while capturing: it was never exceeded to decide.
      expect(run.recorder.queueStats.highWaterBlocks).toBe(2)
      run.frame('d', 104)
      ffmpeg.release()
      await run.recorder.stop()
      // Every accepted frame keeps its whole span; the recording ends where
      // the rejected frame would have started.
      expect(spanCounts(ffmpeg.frames(10))).toEqual({
        a: 10,
        b: 10,
        start: 10,
      })
    },
  )

  it.each([
    {
      label: 'a two-block limit',
      limits: { maxPendingBlocks: 2 },
      seconds: 20,
    },
    // The production limit, held past it in simulated time.
    { label: 'the default limit', limits: undefined, seconds: 1_042 },
  ])(
    'keeps a static page under a stalled encoder within $label',
    async ({ limits, seconds }) => {
      const ffmpeg = createStalledFfmpeg()
      const clock = createHoldClock()
      const run = await startRecorder({ fps: 10 }, 100, ffmpeg, clock, {
        maxPendingBytes: 100,
        ...limits,
      })
      const maxPendingBlocks = limits?.maxPendingBlocks ?? 1_024
      for (let second = 1; second <= seconds; second += 1) {
        run.advance(1_000)
        clock.tick()
      }
      // The first hold's block reached the stalled input; the second waits and
      // shows the page from there, so later holds add no block of their own.
      // The wait itself is still visible: from 0.5 s to half a second ago.
      expect(run.recorder.queueStats).toMatchObject({
        highWaterBlocks: 1,
        highWaterLagSeconds: seconds - 1,
        pendingBlocks: 1,
        pendingBytes: 5,
      })
      expect(run.recorder.incompleteReason).toBeUndefined()
      expect(run.session.listenerCount('Page.screencastFrame')).toBe(1)

      // Stopping at the stall adds only the two end markers.
      const stopping = run.recorder.stop()
      await settle()
      expect(run.recorder.queueStats.pendingBlocks).toBe(3)
      expect(run.recorder.queueStats.pendingBlocks).toBeLessThanOrEqual(
        maxPendingBlocks + 2,
      )

      ffmpeg.release()
      await stopping
      expect(spanCounts(ffmpeg.frames(10))).toEqual({ start: seconds * 10 })
      expect(run.recorder.incompleteReason).toBeUndefined()
      expect(run.recorder.queueStats).toMatchObject({
        pendingBlocks: 0,
        pendingBytes: 0,
      })
    },
  )

  it('counts a held frame once however many waiting blocks show it', async () => {
    const ffmpeg = createStalledFfmpeg()
    const clock = createHoldClock()
    const run = await startRecorder({ fps: 10 }, 100, ffmpeg, clock)
    run.frame('quiet-page', 101)
    run.advance(1_000)
    clock.tick()
    // Stop's end markers repeat the held frame's block.
    const stopping = run.recorder.stop()
    await settle()
    expect(run.recorder.queueStats).toMatchObject({
      pendingBlocks: 3,
      // "quiet-page" decoded is 10 bytes, counted once.
      pendingBytes: 10,
    })
    ffmpeg.release()
    await stopping
    // Shown from 1 s until stop at 2 s.
    expect(spanCounts(ffmpeg.frames(10))).toEqual({
      'quiet-page': 10,
      start: 10,
    })
  })

  it('ends an overloaded recording without moving its last frame earlier', async () => {
    const run = await startRecorder(
      { fps: 10 },
      100,
      createFakeFfmpeg(),
      createClock(),
      {
        maxPendingBytes: 20,
      },
    )
    run.frame('next', 101)
    // Lands on the same grid position as "next", before "next" has a block,
    // and is too large to hold.
    run.frame('y'.repeat(30), 101.04)
    expect(run.recorder.incompleteReason).toContain(
      '40 bytes of frames waiting for the encoder exceeds 20 bytes',
    )

    await run.recorder.stop()
    // "next" starts at 1 s where it arrived. End markers placed before it
    // would have shown it during the last two positions of "start".
    expect(shown(run.frames(10))).toEqual([
      ...Array.from({ length: 10 }, () => 'start'),
      'next',
      'next',
    ])
  })

  it('aborts a stop blocked at capacity and releases everything it queued', async () => {
    const ffmpeg = createStalledFfmpeg()
    const run = await startRecorder({ fps: 10 }, 100, ffmpeg, createClock(), {
      maxPendingBlocks: 2,
    })
    run.frame('a', 101)
    run.frame('b', 102)
    run.advance(1_000)
    const stopping = run.recorder.stop()
    await settle()
    // Two frames at the limit, plus the two end markers.
    expect(run.recorder.queueStats.pendingBlocks).toBe(4)

    // The engine's stop deadline aborts a stop the encoder never drains.
    await run.recorder.abort()
    await expect(stopping).resolves.toBeUndefined()
    expect(run.recorder.queueStats).toMatchObject({
      pendingBlocks: 0,
      pendingBytes: 0,
    })
    expect(run.recorder.incompleteReason).toBeUndefined()
    ffmpeg.release()
    await settle()
    expect(ffmpeg.frames(10)).toEqual([{ label: 'start', position: 0 }])
  })

  it('reports large overloads in MiB', async () => {
    const ffmpeg = createStalledFfmpeg()
    const run = await startRecorder({ fps: 10 }, 100, ffmpeg, createClock(), {
      maxPendingBytes: 1024 * 1024,
    })
    // Base64 of 1.5 MiB is 2 MiB while the frame is held.
    run.frame('x'.repeat(1.5 * 1024 * 1024), 101)
    expect(run.recorder.incompleteReason).toContain(
      '(2.0 MiB of frames waiting for the encoder exceeds 1.0 MiB)',
    )
    ffmpeg.release()
    await run.recorder.stop()
  })

  it('drops waiting frames when the encoder input closes under backpressure', async () => {
    const ffmpeg = createStalledFfmpeg()
    const run = await startRecorder({ fps: 10 }, 100, ffmpeg)
    run.frame('a', 101)
    run.frame('b', 102)
    expect(run.recorder.queueStats.pendingBlocks).toBe(1)

    run.child.stdin?.destroy()
    await settle()

    expect(run.recorder.queueStats.pendingBlocks).toBe(0)
    expect(ffmpeg.frames(10)).toEqual([{ label: 'start', position: 0 }])
  })

  it('reports queue high-water marks for diagnosis', async () => {
    const ffmpeg = createStalledFfmpeg()
    const run = await startRecorder({ fps: 10 }, 100, ffmpeg)
    run.frame('a', 101)
    run.frame('b', 102)
    run.frame('c', 103)
    // The first block reached the stalled input; two more wait behind it,
    // showing "a" and "b" for the two seconds before "c".
    expect(run.recorder.queueStats).toMatchObject({
      highWaterBlocks: 2,
      highWaterLagSeconds: 2,
      pendingBlocks: 2,
    })

    ffmpeg.release()
    await run.recorder.stop()
    expect(run.recorder.queueStats).toMatchObject({
      highWaterBlocks: expect.any(Number),
      pendingBlocks: 0,
      pendingBytes: 0,
    })
    expect(run.recorder.incompleteReason).toBeUndefined()
  })

  it('releases waiting frames when the recording is aborted', async () => {
    const ffmpeg = createStalledFfmpeg()
    const run = await startRecorder({ fps: 10 }, 100, ffmpeg)
    run.frame('a', 101)
    run.frame('b', 102)

    await run.recorder.abort()

    expect(run.recorder.queueStats).toMatchObject({
      pendingBlocks: 0,
      pendingBytes: 0,
    })
    ffmpeg.release()
    await settle()
    // Nothing queued behind the first block is written once aborted.
    expect(ffmpeg.frames(10)).toEqual([{ label: 'start', position: 0 }])
  })

  it('stops retaining frames when the encoder exits during recording', async () => {
    const ffmpeg = createStalledFfmpeg()
    const clock = createHoldClock()
    const run = await startRecorder({ fps: 10 }, 100, ffmpeg, clock)
    run.frame('a', 101)
    run.child.stderr?.emit('data', Buffer.from('Invalid PNG signature\n'))
    Object.assign(run.child, { exitCode: 1 })
    run.child.stdin?.destroy()
    run.child.emit('exit', 1)
    run.child.emit('close', 1)
    await settle()

    expect(run.session.listenerCount('Page.screencastFrame')).toBe(0)
    expect(run.session.sent).toContain('Page.stopScreencast')
    expect(clock.cleared()).toBe(true)
    expect(run.recorder.queueStats.pendingBlocks).toBe(0)
    run.frame('after-exit', 102)
    expect(run.recorder.frameCount).toBe(2)
    await expect(run.recorder.stop()).resolves.toBeUndefined()
    expect(run.recorder.ffmpegResult.code).toBe(1)
    // The encoder's own explanation survives into the recording's status.
    expect(run.recorder.incompleteReason).toBe(
      'FFmpeg exited with code 1 before the recording was stopped: Invalid PNG signature',
    )
  })
})

// FFmpeg exits on its own, as a crash or an output limit in a configured
// wrapper would, with the recorder still capturing.
const exitEncoder = (
  child: ChildProcess,
  outcome: { code: number | null; signal?: NodeJS.Signals },
  close = true,
): void => {
  Object.assign(child, {
    exitCode: outcome.code,
    signalCode: outcome.signal ?? null,
  })
  child.emit('exit', outcome.code, outcome.signal ?? null)
  if (close) {
    child.emit('close', outcome.code, outcome.signal ?? null)
  }
}

describe('screencast recorder encoder exit', () => {
  it.each([
    [
      { code: 0 },
      'FFmpeg exited with code 0 before the recording was stopped.',
    ],
    [
      { code: null, signal: 'SIGKILL' as const },
      'FFmpeg was terminated by SIGKILL before the recording was stopped.',
    ],
  ])(
    'reports an encoder that exits before stop as incomplete: %o',
    async (outcome, reason) => {
      const run = await startRecorder({ fps: 10 }, 100)
      run.frame('a', 101)
      exitEncoder(run.child, outcome)
      await settle()

      // A clean exit code is not a finished recording: FFmpeg never saw the
      // end of its input, so it cannot have encoded what came after.
      expect(run.recorder.incompleteReason).toBe(reason)
      expect(run.session.listenerCount('Page.screencastFrame')).toBe(0)
      await expect(run.recorder.stop()).resolves.toBeUndefined()
      expect(run.recorder.incompleteReason).toBe(reason)
    },
  )

  it('keeps the first reason when an overloaded encoder then exits', async () => {
    const ffmpeg = createStalledFfmpeg()
    const run = await startRecorder({ fps: 10 }, 100, ffmpeg, createClock(), {
      maxPendingBlocks: 1,
    })
    run.frame('a', 101)
    run.frame('b', 102)
    const overload = run.recorder.incompleteReason
    expect(overload).toContain('reached the limit of 1')
    exitEncoder(run.child, { code: 1 })
    await settle()
    expect(run.recorder.incompleteReason).toBe(overload)
  })

  it('reports an exit whose close is still pending when stop ends the input', async () => {
    const run = await startRecorder({ fps: 10 }, 100)
    run.frame('a', 101)
    // The process has exited, but its streams have not all closed yet; the
    // stop that follows ends its input before the close event arrives.
    exitEncoder(run.child, { code: 0 }, false)

    await run.recorder.stop()

    expect(run.recorder.incompleteReason).toBe(
      'FFmpeg exited with code 0 before the recording was stopped.',
    )
  })

  it('reports an exit that precedes an abort, not the abort itself', async () => {
    const run = await startRecorder({ fps: 10 }, 100)
    exitEncoder(run.child, { code: 0 }, false)

    // Retention discards the recording before the close event arrives.
    const aborting = run.recorder.abort()
    run.child.emit('close', 0, null)
    await aborting

    expect(run.recorder.incompleteReason).toBe(
      'FFmpeg exited with code 0 before the recording was stopped.',
    )
  })

  it('does not report an intentional abort as an early exit', async () => {
    const run = await startRecorder({ fps: 10 }, 100)
    run.frame('a', 101)

    await run.recorder.abort()
    await settle()

    expect(run.kill).toHaveBeenCalled()
    expect(run.recorder.incompleteReason).toBeUndefined()
  })

  it('reports an encoder that exits while stop drains its input', async () => {
    const ffmpeg = createStalledFfmpeg()
    const run = await startRecorder({ fps: 10 }, 100, ffmpeg)
    run.frame('a', 101)
    run.frame('b', 102)
    const stopping = run.recorder.stop()
    await settle()

    exitEncoder(run.child, { code: 0 })
    await stopping

    expect(run.recorder.incompleteReason).toBe(
      'FFmpeg exited with code 0 before the recording was stopped.',
    )
  })

  it('leaves an exit after stop ends the input to the encoder result', async () => {
    const run = await startRecorder({ fps: 10 }, 100)
    run.frame('a', 101)
    // FFmpeg fails while finishing the file, after all of its input arrived.
    run.child.stdin?.once('finish', () => {
      Object.assign(run.child, { exitCode: 1 })
    })

    await run.recorder.stop()

    expect(run.recorder.ffmpegResult.code).toBe(1)
    expect(run.recorder.incompleteReason).toBeUndefined()
  })

  it('does not report a graceful stop as an early exit', async () => {
    const run = await startRecorder({ fps: 10 }, 100)
    run.frame('a', 101)
    run.advance(1_000)

    await run.recorder.stop()

    expect(run.recorder.ffmpegResult.code).toBe(0)
    expect(run.recorder.incompleteReason).toBeUndefined()
  })
})

describe('screencast recorder frame timing', () => {
  it('keeps real-time duration when Chrome captures faster than the frame rate', async () => {
    // Puppeteer rounds each 10 ms gap to zero at 24 FPS and writes nothing.
    const harness = await startRecorder({ fps: 24 }, 100)
    for (let frame = 1; frame <= 100; frame += 1) {
      harness.frame(`f${frame}`, 100 + frame * 0.01)
    }
    await settle()
    const frames = harness.frames(24)
    expect(frames).toHaveLength(24)
    expect(frames.map((frame) => frame.position)).toEqual(
      Array.from({ length: 24 }, (_, index) => index),
    )
    // Distinct content survives rather than one frame repeated.
    expect(new Set(frames.map((frame) => frame.label)).size).toBeGreaterThan(20)
    expect(harness.recorder.frameCount).toBe(101)
  })

  it('writes a sparse frame once and lets the video hold it', async () => {
    const harness = await startRecorder({ fps: 30 }, 100)
    harness.frame('half', 100.5)
    harness.frame('one', 101)
    await settle()
    // Each frame reaches the encoder once, not once per grid position.
    expect(harness.frames()).toEqual([
      { label: 'start', position: 0 },
      { label: 'half', position: 15 },
    ])
    await harness.recorder.stop()
    // "one" is the final frame and shown only once, so the recording ends one
    // step later rather than on a lone frame after a gap.
    expect(spanCounts(harness.frames())).toEqual({
      half: 15,
      one: 2,
      start: 15,
    })
  })

  it('does not stretch a recording whose first frame carries a stale timestamp', async () => {
    // Chrome stamped the first frame with a paint from 10 s before capture.
    const harness = await startRecorder({ fps: 10 }, 90)
    harness.advance(100)
    harness.session.emitFrame('next', 100.1)
    await settle()
    // It arrived 0.1 s after the first frame, so it is shown 0.35 s in, not 10.1 s.
    expect(harness.frames(10)).toEqual([{ label: 'start', position: 0 }])

    harness.advance(100)
    harness.session.emitFrame('later', 100.2)
    harness.advance(1_000)
    await harness.recorder.stop()
    // "later" is shown 0.45 s in and held for the 1 s until stop: 1.5 s in all.
    expect(spanCounts(harness.frames(10))).toEqual({
      later: 10,
      next: 1,
      start: 4,
    })
  })

  it('ignores frames without a finite timestamp and never rewinds the grid', async () => {
    const harness = await startRecorder({ fps: 10 }, 100)
    harness.session.emitFrame('missing')
    harness.session.emitFrame('text', '101')
    harness.session.emitFrame('nan', Number.NaN)
    harness.session.emitFrame('backwards', 99)
    harness.frame('later', 101)
    await settle()
    expect(harness.recorder.frameCount).toBe(3)
    // The backwards frame is treated as simultaneous with the first one.
    expect(harness.frames(10)).toEqual([{ label: 'backwards', position: 0 }])
  })

  it('acknowledges every frame so Chrome keeps sending them', async () => {
    const harness = await startRecorder()
    harness.session.emitFrame('next')
    harness.session.emitFrame('timed', 101)
    expect(
      harness.session.sent.filter(
        (method) => method === 'Page.screencastFrameAck',
      ),
    ).toHaveLength(3)
  })

  it('marks a long quiet tail about once a second while recording', async () => {
    // Chrome sends nothing while a page is static. A worker that crashes mid
    // tail should still leave a recording that covers it.
    const clock = createHoldClock()
    const harness = await startRecorder({ fps: 10 }, 100, undefined, clock)
    expect(clock.interval()).toBe(1_000)
    for (let second = 1; second <= 60; second += 1) {
      harness.advance(1_000)
      clock.tick()
    }
    await settle()
    // Held half a second behind real time so late frames keep their place.
    const frames = harness.frames(10)
    expect(frames).toHaveLength(60)
    expect(frames.at(-1)).toEqual({ label: 'start', position: 585 })

    await harness.recorder.stop()

    expect(spanCounts(harness.frames(10))).toEqual({ start: 600 })
    expect(clock.cleared()).toBe(true)
  })

  it('continues the timeline when a quiet page becomes active again', async () => {
    const clock = createHoldClock()
    const harness = await startRecorder({ fps: 10 }, 100, undefined, clock)
    harness.advance(10_000)
    clock.tick()

    harness.frame('active', 110)
    harness.advance(1_000)
    clock.tick()
    await harness.recorder.stop()

    // No frame is repeated or rewound across the transition.
    expect(spanCounts(harness.frames(10))).toEqual({ active: 10, start: 100 })
  })

  it('keeps elapsed duration when a frame arrives behind the held timeline', async () => {
    const clock = createHoldClock()
    const harness = await startRecorder({ fps: 10 }, 100, undefined, clock)
    harness.advance(10_000)
    clock.tick()
    // Painted at 9 s, but the held first frame already reaches 9.5 s.
    harness.session.emitFrame('late', 109)
    harness.advance(1_000)

    await harness.recorder.stop()

    // It is shown from the first unwritten position through stop at 11 s.
    // Delivery lag must not erase a second from the recording.
    expect(spanCounts(harness.frames(10))).toEqual({ late: 15, start: 95 })
  })

  it('keeps every frame of a busy page whose frames arrive late', async () => {
    const clock = createHoldClock()
    const harness = await startRecorder({ fps: 10 }, 100, undefined, clock)
    harness.advance(1_000)
    const late: string[] = []
    for (let frame = 1; frame <= 50; frame += 1) {
      // Painted every 100 ms, each reaching the recorder a second late.
      harness.advance(100)
      harness.session.emitFrame(`f${frame}`, 100 + frame / 10)
      late.push(`f${frame}`)
      clock.tick()
    }

    await harness.recorder.stop()

    // Holding to the local clock while capturing would run ahead of these
    // frames and drop them; each is shown at its own time, and only the last
    // one is held to the 6 s the capture lasted.
    expect(shown(harness.frames(10))).toEqual([
      'start',
      ...late.slice(0, -1),
      ...Array.from({ length: 10 }, () => 'f50'),
    ])
  })

  it('stops holding frames once the recording is aborted', async () => {
    const clock = createHoldClock()
    const harness = await startRecorder({ fps: 10 }, 100, undefined, clock)

    await harness.recorder.abort()
    harness.advance(10_000)
    clock.tick()

    expect(clock.cleared()).toBe(true)
    expect(harness.frames(10)).toEqual([])
  })

  it('holds the last received frame until stop, measured on the local clock', async () => {
    const harness = await startRecorder({ fps: 10 }, 100)
    harness.frame('last', 100.2)
    harness.advance(1_000)

    await harness.recorder.stop()

    // 0.2 s of "start", then "last" from 0.2 s until 1.2 s. Puppeteer would
    // drop "last" and repeat "start" instead.
    expect(spanCounts(harness.frames(10))).toEqual({ last: 10, start: 2 })
    expect(harness.session.sent).toContain('Page.stopScreencast')
    expect(harness.session.detach).toHaveBeenCalled()
  })

  it('applies playback speed to frame timestamps and the output grid', async () => {
    const harness = await startRecorder({ fps: 10, speed: 2 }, 100)
    harness.frame('next', 102)
    harness.advance(1_000)
    await harness.recorder.stop()

    const stream = parseMatroskaStream(harness.bytes())
    // Two capture seconds play in one; FFmpeg's time base follows the grid.
    expect(stream.track?.defaultDurationNs).toBe(50_000_000)
    expect(stream.frames.map((frame) => frame.timestampMs)).toEqual([
      0, 1_000, 1_400, 1_450,
    ])
  })

  it('ends on two frames one step apart so the final frame keeps its length', async () => {
    const harness = await startRecorder({ fps: 10 }, 100)
    harness.frame('last', 102)
    harness.advance(3_000)

    await harness.recorder.stop()

    // A player sizes the last frame from the gap before it.
    expect(harness.frames(10)).toEqual([
      { label: 'start', position: 0 },
      { label: 'last', position: 20 },
      { label: 'last', position: 48 },
      { label: 'last', position: 49 },
    ])
  })

  it('extends by one step rather than leave a lone final frame', async () => {
    const harness = await startRecorder({ fps: 10 }, 100)
    // Arrives just before stop, so its only position is the last one.
    harness.frame('last', 101.9)
    harness.advance(50)

    await harness.recorder.stop()

    expect(harness.frames(10)).toEqual([
      { label: 'start', position: 0 },
      { label: 'last', position: 19 },
      { label: 'last', position: 20 },
    ])
  })

  it('writes a lone frame at least once and stops only once', async () => {
    const harness = await startRecorder({ fps: 30 }, 100)

    await Promise.all([harness.recorder.stop(), harness.recorder.stop()])
    harness.session.emitFrame('after-stop', 105)

    expect(shown(harness.frames())).toEqual(['start'])
    expect(
      harness.session.sent.filter((method) => method === 'Page.stopScreencast'),
    ).toHaveLength(1)
    expect(harness.session.listenerCount('Page.screencastFrame')).toBe(0)
  })

  it('finishes an empty recording when no frame ever arrived', async () => {
    const ffmpeg = createFakeFfmpeg()
    const session = createFakeSession()
    const clock = createClock()
    const starting = recordScreencast(createPage(session), options, {
      clock,
      spawnProcess: ffmpeg.spawn,
    })
    await vi.waitFor(() => {
      expect(session.sent).toContain('Page.startScreencast')
    })
    clock.expire()
    const recorder = await starting

    await recorder.stop()

    expect(ffmpeg.frames()).toEqual([])
    expect(ffmpeg.child.exitCode).toBe(0)
    // A graceful stop lets FFmpeg exit by itself.
    expect(ffmpeg.kill).not.toHaveBeenCalled()
  })

  it('tolerates a closed CDP session and an FFmpeg that already exited', async () => {
    const harness = await startRecorder({ fps: 10 }, 100)
    vi.mocked(harness.session.send).mockRejectedValue(
      new Error('Target closed'),
    )
    vi.mocked(harness.session.detach).mockRejectedValue(
      new Error('Session already detached'),
    )
    harness.child.stdin?.end()
    await vi.waitFor(() => {
      expect(harness.child.exitCode).toBe(0)
    })

    // FFmpeg exited, so the recorder stopped listening and let go of the
    // session.
    expect(harness.session.detach).toHaveBeenCalledOnce()
    harness.session.emitFrame('late', 101)
    await expect(harness.recorder.stop()).resolves.toBeUndefined()

    expect(harness.frames(10)).toEqual([])
    expect(harness.recorder.frameCount).toBe(1)
    expect(harness.session.listenerCount('Page.screencastFrame')).toBe(0)
  })
  it('keeps the end of FFmpeg error output for diagnosis', async () => {
    const harness = await startRecorder()
    const stderr = harness.child.stderr as PassThrough
    stderr.write('x'.repeat(5_000))
    stderr.write('\n[png @ 0] Invalid PNG signature\n')
    await new Promise((resolve) => setImmediate(resolve))
    expect(harness.recorder.ffmpegResult).toEqual({
      code: null,
      diagnostic: expect.stringMatching(
        /^x+\n\[png @ 0\] Invalid PNG signature$/u,
      ),
      signal: null,
    })
    expect(harness.recorder.ffmpegResult.diagnostic.length).toBeLessThanOrEqual(
      4_000,
    )

    await harness.recorder.stop()

    expect(harness.recorder.ffmpegResult.code).toBe(0)
  })
  it('decodes a character split across FFmpeg error chunks', async () => {
    const harness = await startRecorder()
    const stderr = harness.child.stderr as PassThrough
    const message = Buffer.from('encoder 日本語 error')
    stderr.write(message.subarray(0, 9))
    stderr.write(message.subarray(9))
    await new Promise((resolve) => setImmediate(resolve))
    expect(harness.recorder.ffmpegResult.diagnostic).toBe(
      'encoder 日本語 error',
    )

    await harness.recorder.stop()

    expect(harness.recorder.ffmpegResult.diagnostic).toBe(
      'encoder 日本語 error',
    )
  })

  it('stops FFmpeg and the CDP session when aborted', async () => {
    const harness = await startRecorder()

    await harness.recorder.abort()

    expect(harness.kill).toHaveBeenCalledTimes(1)
    expect(harness.session.detach).toHaveBeenCalled()
    harness.session.emitFrame('ignored', 200)
    expect(harness.frames(10)).toEqual([])
  })

  it('terminates the encoder when aborted during a stalled CDP stop', async () => {
    const harness = await startRecorder()
    const { promise: stalledStop, resolve: finishLate } =
      Promise.withResolvers<never>()
    vi.mocked(harness.session.send).mockImplementation(() => stalledStop)
    const stopping = harness.recorder.stop()

    void harness.recorder.abort()
    await new Promise((resolve) => setImmediate(resolve))

    expect(harness.kill).toHaveBeenCalledOnce()
    await expect(stopping).resolves.toBeUndefined()
    expect(harness.session.listenerCount('Page.screencastFrame')).toBe(0)
    finishLate({} as never)
    await new Promise((resolve) => setImmediate(resolve))
    expect(harness.frames(10)).toEqual([])
  })

  it('aborts an encoder that never exits after input ends, exactly once', async () => {
    const harness = await startRecorder({}, 100, createFakeFfmpeg(false))
    const stopping = harness.recorder.stop()
    await vi.waitFor(() => {
      expect(harness.child.stdin?.writableEnded).toBe(true)
    })

    await Promise.all([harness.recorder.abort(), harness.recorder.abort()])

    await expect(stopping).resolves.toBeUndefined()
    expect(harness.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(harness.session.detach).toHaveBeenCalledOnce()
    expect(harness.child.unref).toHaveBeenCalledOnce()
    expect(harness.child.stderr?.destroyed).toBe(true)
  })

  it('settles cancellation even when session detach never replies', async () => {
    const harness = await startRecorder()
    vi.mocked(harness.session.detach).mockImplementation(
      () => new Promise(() => {}),
    )
    const stopping = harness.recorder.stop()
    await vi.waitFor(() => {
      expect(harness.child.exitCode).toBe(0)
    })

    await harness.recorder.abort()

    await expect(stopping).resolves.toBeUndefined()
    expect(harness.kill).not.toHaveBeenCalled()
  })

  it('cancels the first-frame wait and releases its timer when aborted', async () => {
    const ffmpeg = createFakeFfmpeg()
    const session = createFakeSession()
    const clock = createClock()
    const cleared = vi.spyOn(clock, 'clearTimeout')
    const recorder = createRecorder(ffmpeg, session)
    const firstFrame = recorder.waitForFirstFrame(clock)
    await recorder.abort()
    await expect(firstFrame).resolves.toBeUndefined()
    expect(cleared).toHaveBeenCalledOnce()
    expect(session.detach).toHaveBeenCalledOnce()
    expect(session.listenerCount('Page.screencastFrame')).toBe(0)
  })

  it('bounds cleanup when a terminated process never reports close', async () => {
    vi.useFakeTimers()
    const ffmpeg = createFakeFfmpeg(false)
    const terminateProcessTree = vi.fn(async () => {})
    const recorder = ScreencastRecorder.create({
      canvas: { width: 1280, height: 720 },
      clock: systemClock,
      fps: 30,
      monotonicNow: () => 0,
      session: createFakeSession(),
      sink: new EncoderSink(ffmpeg.child, {
        clock: systemClock,
        terminateProcessTree,
      }),
    })
    try {
      const aborted = recorder.abort()
      await vi.advanceTimersByTimeAsync(500)
      await expect(aborted).resolves.toBeUndefined()
      expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith(
        ffmpeg.child,
        true,
      )
      expect(ffmpeg.child.unref).toHaveBeenCalledOnce()
      expect(ffmpeg.child.stderr?.destroyed).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
      expect(ffmpeg.child.listenerCount('spawn')).toBe(0)
      expect(ffmpeg.child.listenerCount('exit')).toBe(0)
      expect(ffmpeg.child.stderr?.listenerCount('data')).toBe(0)
      // Recorder listeners are gone; a stateless guard handles delayed errors
      // until the real close arrives.
      ffmpeg.child.emit('error', new Error('late termination error'))
      ffmpeg.child.emit('close', null)
      expect(ffmpeg.child.listenerCount('error')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('screencast recorder startup', () => {
  it.each(['encoder-exit', 'target-close'] as const)(
    'rejects %s in the same turn as a successful start and first frame',
    async (failure) => {
      const ffmpeg = createFakeFfmpeg()
      const events = new EventEmitter()
      const session = createFakeSession((method, current) => {
        if (method === 'Page.startScreencast') {
          current.emitFrame('first', 1)
          if (failure === 'encoder-exit') {
            Object.assign(ffmpeg.child, { exitCode: 7 })
            ffmpeg.child.emit('exit', 7)
          } else {
            events.emit('close')
          }
        }
      })
      const page = Object.assign(createPage(session), {
        once: events.once.bind(events),
        off: events.off.bind(events),
      })
      const result = await recordScreencast(page, options, {
        spawnProcess: ffmpeg.spawn,
      }).catch((error: unknown) => error)
      // Clean up even when a regression incorrectly hands back a live recorder.
      if (result instanceof ScreencastRecorder) {
        await result.abort()
      }
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toContain(
        failure === 'encoder-exit' ? 'exited with code 7' : 'Page closed',
      )
      expect(session.detach).toHaveBeenCalledOnce()
    },
  )

  it.each(['exit', 'close', 'error'] as const)(
    'observes encoder %s while attachment is pending and disposes the late session',
    async (event) => {
      const ffmpeg = createFakeFfmpeg()
      const session = createFakeSession()
      const attachment = Promise.withResolvers<CDPSession>()
      const page = createPage(session)
      vi.mocked(page.createCDPSession).mockReturnValue(attachment.promise)
      const starting = recordScreencast(page, options, {
        spawnProcess: ffmpeg.spawn,
      })
      const result = starting.catch((error: unknown) => error)
      await vi.waitFor(() =>
        expect(page.createCDPSession).toHaveBeenCalledOnce(),
      )
      ffmpeg.child.stderr?.emit('data', Buffer.from('early encoder diagnostic'))
      if (event === 'error') {
        ffmpeg.child.emit('error', new Error('encoder process error'))
      } else {
        Object.assign(ffmpeg.child, { exitCode: 7 })
        ffmpeg.child.emit(event, 7)
      }
      const error = await result
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(
        event === 'error'
          ? 'encoder process error'
          : 'early encoder diagnostic',
      )
      attachment.resolve(session)
      await new Promise((resolve) => setImmediate(resolve))
      expect(session.detach).toHaveBeenCalledOnce()
      expect(session.send).not.toHaveBeenCalled()
      expect(session.listenerCount('Page.screencastFrame')).toBe(0)
      expect(ffmpeg.child.stdin?.destroyed).toBe(true)
      expect(ffmpeg.child.stderr?.destroyed).toBe(true)
    },
  )

  it('uses process-tree supervision when attachment rejects before a recorder exists', async () => {
    const ffmpeg = createFakeFfmpeg()
    const page = createPage(createFakeSession())
    vi.mocked(page.createCDPSession).mockRejectedValue(
      new Error('attach rejected'),
    )
    const terminateProcessTree = vi.fn(async () => {
      ffmpeg.child.kill()
    })
    await expect(
      recordScreencast(page, options, {
        spawnProcess: ffmpeg.spawn,
        terminateProcessTree,
      }),
    ).rejects.toThrow('attach rejected')
    expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith(
      ffmpeg.child,
      true,
    )
    expect(ffmpeg.child.unref).toHaveBeenCalledOnce()
    expect(ffmpeg.child.listenerCount('close')).toBe(0)
    expect(ffmpeg.child.listenerCount('error')).toBe(0)
  })

  it.each(['attach', 'start'] as const)(
    'bounds stalled CDP %s and ignores late completion',
    async (stage) => {
      vi.useFakeTimers()
      const ffmpeg = createFakeFfmpeg()
      const session = createFakeSession()
      const page = createPage(session)
      const attachment = Promise.withResolvers<CDPSession>()
      const start = Promise.withResolvers<never>()
      if (stage === 'attach') {
        vi.mocked(page.createCDPSession).mockReturnValue(attachment.promise)
        vi.mocked(session.detach).mockRejectedValue(
          new Error('target already detached'),
        )
      } else {
        vi.mocked(session.send).mockReturnValue(start.promise)
      }
      const starting = recordScreencast(page, options, {
        spawnProcess: ffmpeg.spawn,
      })
      const rejected = expect(starting).rejects.toThrow(
        'CDP startup timed out after 10000ms',
      )
      try {
        await vi.advanceTimersByTimeAsync(10_001)
        await rejected
        attachment.resolve(session)
        start.resolve({} as never)
        await vi.advanceTimersByTimeAsync(0)
        expect(session.detach).toHaveBeenCalledOnce()
        expect(session.listenerCount('Page.screencastFrame')).toBe(0)
        expect(ffmpeg.kill).toHaveBeenCalledOnce()
        session.emitFrame('late', 100)
        expect(ffmpeg.frames()).toEqual([])
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('cancels attachment when the target closes, without waiting for the deadline', async () => {
    const ffmpeg = createFakeFfmpeg()
    const session = createFakeSession()
    const attachment = Promise.withResolvers<CDPSession>()
    const events = new EventEmitter()
    const page = Object.assign(createPage(session), {
      once: events.once.bind(events),
      off: events.off.bind(events),
    })
    vi.mocked(page.createCDPSession).mockReturnValue(attachment.promise)
    const result = recordScreencast(page, options, {
      spawnProcess: ffmpeg.spawn,
    }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(page.createCDPSession).toHaveBeenCalledOnce())
    events.emit('close')
    expect(await result).toMatchObject({
      message: 'Page closed during screencast startup',
    })
    attachment.resolve(session)
    await new Promise((resolve) => setImmediate(resolve))
    expect(session.detach).toHaveBeenCalledOnce()
    expect(events.listenerCount('close')).toBe(0)
    expect(ffmpeg.kill).toHaveBeenCalledOnce()
  })

  it('keeps the first-frame budget separate after a slow successful attachment', async () => {
    vi.useFakeTimers()
    const ffmpeg = createFakeFfmpeg()
    const session = createFakeSession()
    const attachment = Promise.withResolvers<CDPSession>()
    const page = createPage(session)
    vi.mocked(page.createCDPSession).mockReturnValue(attachment.promise)
    let completed = false
    const starting = recordScreencast(page, options, {
      spawnProcess: ffmpeg.spawn,
    }).then((recorder) => {
      completed = true
      return recorder
    })
    try {
      await vi.advanceTimersByTimeAsync(9_500)
      attachment.resolve(session)
      await vi.advanceTimersByTimeAsync(501)
      expect(completed).toBe(false)
      await vi.advanceTimersByTimeAsync(500)
      const recorder = await starting
      expect(recorder.frameCount).toBe(0)
      const aborted = recorder.abort()
      await vi.advanceTimersByTimeAsync(1)
      await aborted
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shares the CDP deadline between attachment and start', async () => {
    vi.useFakeTimers()
    const ffmpeg = createFakeFfmpeg()
    const session = createFakeSession()
    const attachment = Promise.withResolvers<CDPSession>()
    const page = createPage(session)
    vi.mocked(page.createCDPSession).mockReturnValue(attachment.promise)
    vi.mocked(session.send).mockReturnValue(new Promise(() => {}))
    const starting = recordScreencast(page, options, {
      spawnProcess: ffmpeg.spawn,
    })
    const rejected = expect(starting).rejects.toThrow(
      'CDP startup timed out after 10000ms',
    )
    try {
      await vi.advanceTimersByTimeAsync(9_500)
      attachment.resolve(session)
      await vi.advanceTimersByTimeAsync(501)
      await rejected
      expect(session.detach).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores native viewport emulation even when changing it rejects', async () => {
    const viewport = { width: 640, height: 360, deviceScaleFactor: 2 }
    const page = createPage(createFakeSession(), { viewport })
    page.setViewport.mockRejectedValueOnce(new Error('resize rejected'))
    const spawnProcess = vi.fn()
    await expect(
      recordScreencast(page, options, { spawnProcess }),
    ).rejects.toThrow('resize rejected')
    expect(page.setViewport).toHaveBeenLastCalledWith(viewport)
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('measures native pixels at device scale 0 and restores the emulated viewport', async () => {
    const ffmpeg = createFakeFfmpeg()
    const session = createFakeSession((method, current) => {
      if (method === 'Page.startScreencast') {
        current.emitFrame('start', 1)
      }
    })
    const viewport: Viewport = { width: 640, height: 360, deviceScaleFactor: 2 }
    const page = createPage(session, {
      devicePixelRatio: 2,
      height: 360,
      viewport,
      width: 640,
    })
    vi.mocked(page.evaluate).mockImplementationOnce((async (
      callback: () => unknown,
    ) => {
      // Run the in-page measurement against a stand-in browser window.
      const view = {
        devicePixelRatio: 2,
        visualViewport: { width: 640, height: 360 },
      }
      Object.assign(globalThis, view)
      try {
        return callback()
      } finally {
        Reflect.deleteProperty(globalThis, 'devicePixelRatio')
        Reflect.deleteProperty(globalThis, 'visualViewport')
      }
    }) as never)
    const spawnProcess = vi.fn((_command: string, _args: string[]) =>
      ffmpeg.spawn(),
    )

    await recordScreencast(
      page,
      { ...options, crop: { x: 10, y: 20, width: 300, height: 100 } },
      { clock: createClock(), spawnProcess },
    )

    expect(page.setViewport).toHaveBeenNthCalledWith(1, {
      ...viewport,
      deviceScaleFactor: 0,
    })
    expect(page.setViewport).toHaveBeenNthCalledWith(2, viewport)
    const args = spawnProcess.mock.calls[0]?.[1] ?? []
    expect(args[args.indexOf('-vf') + 1]).toContain(
      "crop='min(1280,iw):min(720,ih):0:0',pad=1280:720:0:0",
    )
    // Crop is requested in CSS pixels and applied in device pixels.
    expect(args[args.indexOf('-vf') + 1]).toContain('crop=600:200:20:40')
  })

  it.each([
    [{ x: -1, y: 0, width: 10, height: 10 }, '`crop.x` and `crop.y`'],
    [{ x: 0, y: 0, width: 0, height: 10 }, '`crop.height` and `crop.width`'],
    [
      { x: 700, y: 0, width: 600, height: 10 },
      '`crop.width` cannot be larger than the viewport width (1280).',
    ],
    [
      { x: 0, y: 700, width: 10, height: 30 },
      '`crop.height` cannot be larger than the viewport height (720).',
    ],
  ])('rejects crop %j before starting FFmpeg', async (crop, message) => {
    const spawnProcess = vi.fn()
    const page = createPage(createFakeSession())

    await expect(
      recordScreencast(page, { ...options, crop }, { spawnProcess }),
    ).rejects.toThrow(message)
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(page.createCDPSession).not.toHaveBeenCalled()
  })

  it('normalizes a crop with negative width and height like Puppeteer', async () => {
    const ffmpeg = createFakeFfmpeg()
    const spawnProcess = vi.fn((_command: string, _args: string[]) =>
      ffmpeg.spawn(),
    )
    const session = createFakeSession((method, current) => {
      if (method === 'Page.startScreencast') {
        current.emitFrame('start', 1)
      }
    })

    await recordScreencast(
      createPage(session),
      { ...options, crop: { x: 110.4, y: 60, width: -100, height: -50 } },
      { clock: createClock(), spawnProcess },
    )

    const args = spawnProcess.mock.calls[0]?.[1] ?? []
    expect(args[args.indexOf('-vf') + 1]).toContain('crop=100:50:10:10')
  })

  it('does not wait forever for a first frame that never arrives', async () => {
    const ffmpeg = createFakeFfmpeg()
    const session = createFakeSession()
    const clock = createClock()

    const starting = recordScreencast(createPage(session), options, {
      clock,
      spawnProcess: ffmpeg.spawn,
    })
    await vi.waitFor(() => {
      expect(session.sent).toContain('Page.startScreencast')
    })
    clock.expire()

    const recorder = await starting
    expect(recorder.frameCount).toBe(0)
  })

  it('rejects without opening a CDP session when FFmpeg cannot start', async () => {
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { kill: vi.fn(), stdin: null, stdout: null })
    const spawnProcess = (): ChildProcess => {
      queueMicrotask(() =>
        child.emit('error', new Error('spawn ffmpeg ENOENT')),
      )
      return child
    }
    const page = createPage(createFakeSession())

    await expect(
      recordScreencast(page, options, { spawnProcess }),
    ).rejects.toThrow('ENOENT')
    expect(page.createCDPSession).not.toHaveBeenCalled()
  })

  it('stops FFmpeg and detaches when the screencast cannot start', async () => {
    const ffmpeg = createFakeFfmpeg()
    const session = createFakeSession()
    vi.mocked(session.send).mockRejectedValueOnce(new Error('Target closed'))

    await expect(
      recordScreencast(createPage(session), options, {
        spawnProcess: ffmpeg.spawn,
      }),
    ).rejects.toThrow('Target closed')
    expect(ffmpeg.kill).toHaveBeenCalled()
    expect(session.detach).toHaveBeenCalled()
    expect(session.listenerCount('Page.screencastFrame')).toBe(0)
  })

  it('stops FFmpeg when a CDP session cannot be created', async () => {
    const ffmpeg = createFakeFfmpeg()
    const page = createPage(createFakeSession())
    vi.mocked(page.createCDPSession).mockRejectedValueOnce(
      new Error('Protocol error'),
    )

    await expect(
      recordScreencast(page, options, { spawnProcess: ffmpeg.spawn }),
    ).rejects.toThrow('Protocol error')
    expect(ffmpeg.kill).toHaveBeenCalled()
  })
})

// A spool file the recorder writes through, with writes the test controls.
const createFakeSpool = (failOnWrite?: number) => {
  const chunks: Buffer[] = []
  const waiting: Array<() => void> = []
  let flowing = true
  let writes = 0
  let written = 0
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      writes += 1
      if (writes === failOnWrite) {
        callback(
          Object.assign(new Error('ENOSPC: no space left on device, write'), {
            code: 'ENOSPC',
          }),
        )
        return
      }
      const accept = (): void => {
        chunks.push(Buffer.from(chunk))
        written += chunk.length
        callback()
      }
      if (flowing) {
        accept()
      } else {
        waiting.push(accept)
      }
    },
  }) as SpoolFileStream
  Object.defineProperty(stream, 'bytesWritten', { get: () => written })
  return {
    /** What is on disk now, as a killed worker would leave it. */
    bytes: () => Buffer.concat(chunks),
    frames: (fps = 30) => gridFrames(Buffer.concat(chunks), fps),
    open: vi.fn((_path: string) => stream),
    release: () => {
      flowing = true
      for (const accept of waiting.splice(0)) {
        accept()
      }
    },
    stall: () => {
      flowing = false
    },
    stream,
  }
}

// The shared capture settings, without the live encode's output path.
const { outputPath: _liveOutput, ...captureOptions } =
  options as typeof options & {
    outputPath: string
  }
const spoolOptions = { ...captureOptions, spoolPath: 'segment.spool.mkv' }

const startedOnFirstFrame = (timestamp: number) =>
  createFakeSession((method, current) => {
    if (method === 'Page.startScreencast') {
      current.emitFrame('start', timestamp)
    }
  })

// `startRecorder`, spooling to a fake file instead of spawning FFmpeg.
const startSpoolRecorder = async (
  recorderOptions: Partial<ScreencastCaptureOptions> & {
    budget?: SpoolBudget
  } = {},
  spool = createFakeSpool(),
  clock: ClockBoundary = createClock(),
  queueLimits?: { maxPendingBytes?: number; maxPendingBlocks?: number },
) => {
  const session = startedOnFirstFrame(100)
  let monotonic = 0
  const spawnProcess = vi.fn()
  const recorder = await recordScreencast(
    createPage(session),
    { ...spoolOptions, ...recorderOptions },
    {
      clock,
      monotonicNow: () => monotonic,
      openSpoolFile: spool.open,
      spawnProcess,
      ...(queueLimits ? { queueLimits } : {}),
    },
  )
  return {
    ...spool,
    advance: (milliseconds: number) => {
      monotonic += milliseconds
    },
    frame: (label: string, timestamp: number) => {
      monotonic = (timestamp - 100) * 1_000
      session.emitFrame(label, timestamp)
    },
    recorder,
    session,
    spawnProcess,
  }
}

type ScriptStep =
  | { readonly frame: string; readonly at: number }
  | { readonly hold: number }

// Plays the same frames and holds to a live recorder or a spooling one.
const playScript = async (
  run: {
    advance: (milliseconds: number) => void
    frame: (label: string, timestamp: number) => void
  },
  clock: ReturnType<typeof createHoldClock>,
  steps: readonly ScriptStep[],
): Promise<void> => {
  for (const step of steps) {
    if ('frame' in step) {
      run.frame(step.frame, step.at)
    } else {
      run.advance(step.hold)
      clock.tick()
    }
    await settle()
  }
}

const SCRIPT: readonly ScriptStep[] = [
  { frame: 'red', at: 100.5 },
  { hold: 1_000 },
  // A busy burst, inside one grid step and across a few.
  { frame: 'green', at: 101.6 },
  { frame: 'green-2', at: 101.61 },
  { frame: 'blue', at: 101.7 },
  { hold: 1_000 },
  { hold: 1_000 },
  { hold: 1_000 },
  { frame: 'red-again', at: 105 },
  { hold: 1_000 },
  { hold: 1_000 },
]

describe('screencast recorder spooling', () => {
  it('writes a spool byte-for-byte as the live encoder is given, holds included', async () => {
    const liveClock = createHoldClock()
    const live = await startRecorder(
      { fps: 10 },
      100,
      createFakeFfmpeg(),
      liveClock,
    )
    await playScript(live, liveClock, SCRIPT)
    live.advance(500)
    await live.recorder.stop()

    const spoolClock = createHoldClock()
    const spooled = await startSpoolRecorder({ fps: 10 }, undefined, spoolClock)
    // The spool holds on the same cadence as a live encoder.
    expect(spoolClock.interval()).toBe(1_000)
    await playScript(spooled, spoolClock, SCRIPT)
    spooled.advance(500)
    await spooled.recorder.stop()

    expect(spooled.bytes().equals(live.bytes())).toBe(true)
    // Holds are in both: blocks repeat a frame that is still shown.
    const labels = spooled.frames(10).map((frame) => frame.label)
    expect(labels.filter((label) => label === 'blue').length).toBeGreaterThan(2)
    // A spool's byte count includes its hold blocks.
    expect(spooled.stream.bytesWritten).toBe(live.bytes().length)
    expect(spooled.spawnProcess).not.toHaveBeenCalled()
    expect(spooled.recorder.incompleteReason).toBeUndefined()
    expect(spoolClock.cleared()).toBe(true)
  })

  it('has the first frame on disk after one hold, without a stop', async () => {
    const clock = createHoldClock()
    const run = await startSpoolRecorder({ fps: 10 }, undefined, clock)
    expect(run.frames(10)).toEqual([])

    run.advance(1_000)
    clock.tick()
    await settle()
    // A worker killed now leaves the first frame, held up to the hold.
    expect(run.frames(10)).toEqual([{ label: 'start', position: 0 }])

    for (let second = 2; second <= 10; second += 1) {
      run.advance(1_000)
      clock.tick()
    }
    await settle()
    // The quiet tail is on disk up to the last hold, half a second behind.
    expect(run.frames(10).at(-1)).toEqual({ label: 'start', position: 85 })
    await run.recorder.abort()
  })

  it('has the newest image on disk one hold after red, green and blue', async () => {
    const clock = createHoldClock()
    const run = await startSpoolRecorder({ fps: 10 }, undefined, clock)
    run.frame('red', 101)
    run.frame('green', 102)
    run.frame('blue', 103)
    await settle()
    // Blue has no span yet: only the next frame, a hold or stop gives one.
    expect(run.frames(10).map((frame) => frame.label)).not.toContain('blue')

    run.advance(1_000)
    clock.tick()
    await settle()
    expect(shown(run.frames(10))).toEqual([
      ...Array.from({ length: 10 }, () => 'start'),
      ...Array.from({ length: 10 }, () => 'red'),
      ...Array.from({ length: 10 }, () => 'green'),
      'blue',
    ])
    run.advance(5_000)
    clock.tick()
    await settle()
    expect(run.frames(10).at(-1)).toEqual({ label: 'blue', position: 35 })
    await run.recorder.abort()
  })

  it('reports itself as a spool with what its encode needs', async () => {
    const spool = createFakeSpool()
    const recorder = await recordScreencast(
      createPage(startedOnFirstFrame(1), { width: 1920, height: 1080 }),
      {
        ...spoolOptions,
        format: 'mp4',
        maxWidth: 1280,
        quality: 24,
        scale: 0.5,
      },
      {
        clock: createClock(),
        monotonicNow: () => 0,
        openSpoolFile: spool.open,
      },
    )
    await recorder.stop()

    expect(spool.open).toHaveBeenCalledExactlyOnceWith('segment.spool.mkv')
    expect(recorder.output).toEqual({
      kind: 'spool',
      spool: {
        path: 'segment.spool.mkv',
        settings: {
          canvas: { width: 1280, height: 720 },
          format: 'mp4',
          quality: 24,
          scale: 0.5,
        },
      },
    })
    expect(parseMatroskaStream(spool.bytes()).track).toMatchObject({
      height: 720,
      width: 1280,
    })
    // No encoder ran, so none exited.
    expect(recorder.ffmpegResult).toEqual({
      code: null,
      diagnostic: '',
      signal: null,
    })
  })

  it('carries the device-pixel crop into the spool description', async () => {
    const recorder = await recordScreencast(
      createPage(startedOnFirstFrame(1), {
        devicePixelRatio: 2,
        width: 640,
        height: 360,
      }),
      { ...spoolOptions, crop: { x: 10, y: 20, width: 300, height: 100 } },
      {
        clock: createClock(),
        monotonicNow: () => 0,
        openSpoolFile: createFakeSpool().open,
      },
    )
    expect(recorder.output).toMatchObject({
      spool: {
        settings: {
          canvas: { width: 1280, height: 720 },
          crop: { x: 20, y: 40, width: 600, height: 200 },
        },
      },
    })
    await recorder.abort()
  })

  it('reports an encoded output for a live recording', async () => {
    const run = await startRecorder()
    expect(run.recorder.output).toEqual({ kind: 'encoded' })
    await run.recorder.stop()
  })

  it('ends a stopped spool with the same final fill and end markers as live', async () => {
    const live = await startRecorder({ fps: 10 }, 100)
    live.frame('last', 102)
    live.advance(3_000)
    await live.recorder.stop()

    const spooled = await startSpoolRecorder({ fps: 10 })
    spooled.frame('last', 102)
    spooled.advance(3_000)
    await spooled.recorder.stop()

    expect(spooled.frames(10)).toEqual([
      { label: 'start', position: 0 },
      { label: 'last', position: 20 },
      { label: 'last', position: 48 },
      { label: 'last', position: 49 },
    ])
    expect(spooled.bytes().equals(live.bytes())).toBe(true)
    expect(spooled.stream.writableFinished).toBe(true)
  })

  it('stops capturing with a truthful reason when the spool cannot be written', async () => {
    const clock = createHoldClock()
    // The header is the first write; the first frame's block fails.
    const run = await startSpoolRecorder({ fps: 10 }, createFakeSpool(3), clock)
    run.frame('a', 101)
    await vi.waitFor(() => {
      expect(run.recorder.incompleteReason).toBe(
        'The frame spool could not be written: ENOSPC: no space left on device, write',
      )
    })
    await settle()

    expect(run.session.listenerCount('Page.screencastFrame')).toBe(0)
    expect(run.session.sent).toContain('Page.stopScreencast')
    expect(clock.cleared()).toBe(true)
    expect(run.recorder.queueStats.pendingBlocks).toBe(0)
    await expect(run.recorder.stop()).resolves.toBeUndefined()
    expect(run.recorder.incompleteReason).toMatch(/ENOSPC/u)
    expect(run.recorder.output.kind).toBe('spool')
  })

  it('reports a spool that fails to flush when stop ends it', async () => {
    const spool = createFakeSpool()
    Object.assign(spool.stream, {
      _final: (callback: (error?: Error) => void) => {
        callback(new Error('EIO: i/o error, write'))
      },
    })
    const run = await startSpoolRecorder({ fps: 10 }, spool)
    run.frame('a', 101)

    await run.recorder.stop()

    expect(run.recorder.incompleteReason).toBe(
      'The frame spool could not be written: EIO: i/o error, write',
    )
  })

  it('bounds the frames waiting for a stalled spool and names it', async () => {
    const spool = createFakeSpool()
    spool.stall()
    const run = await startSpoolRecorder({ fps: 10 }, spool, createClock(), {
      maxPendingBlocks: 2,
    })
    run.frame('a', 101)
    run.frame('b', 102)
    run.frame('c', 103)
    run.frame('d', 104)

    expect(run.recorder.incompleteReason).toBe(
      'The frame spool fell behind the screencast (2 frames waiting for the frame spool reached the limit of 2); capture stopped after 3.0s to bound memory.',
    )
    spool.release()
    await run.recorder.stop()
    expect(spanCounts(run.frames(10))).toEqual({ a: 10, b: 10, start: 10 })
  })

  it.each(['capturing', 'draining', 'ending'] as const)(
    'aborts a spool while %s, as the stop deadline does, and closes it',
    async (state) => {
      const spool = createFakeSpool()
      const run = await startSpoolRecorder({ fps: 10 }, spool)
      run.frame('a', 101)
      let stopping: Promise<void> | undefined
      if (state !== 'capturing') {
        spool.stall()
        run.frame('b', 102)
        stopping = run.recorder.stop()
        await settle()
      }
      if (state === 'ending') {
        // Everything was handed over; the file never finishes flushing.
        Object.assign(spool.stream, {
          _final: () => {
            // The flush never completes.
          },
        })
        spool.release()
        await vi.waitFor(() => {
          expect(spool.stream.writableEnded).toBe(true)
        })
      }

      await run.recorder.abort()

      await expect(stopping ?? Promise.resolve()).resolves.toBeUndefined()
      expect(spool.stream.destroyed).toBe(true)
      expect(run.recorder.queueStats).toMatchObject({
        pendingBlocks: 0,
        pendingBytes: 0,
      })
      expect(run.recorder.incompleteReason).toBeUndefined()
      expect(run.session.detach).toHaveBeenCalled()
    },
  )
})

describe('screencast recorder deferred startup', () => {
  it('spawns no encoder and waits only for the spool file to open', async () => {
    const spool = createFakeSpool()
    Object.assign(spool.stream, { pending: true })
    const page = createPage(startedOnFirstFrame(1))
    const spawnProcess = vi.fn()
    const starting = recordScreencast(page, spoolOptions, {
      clock: createClock(),
      openSpoolFile: spool.open,
      spawnProcess,
    })
    await settle()
    expect(page.createCDPSession).not.toHaveBeenCalled()

    spool.stream.emit('ready')
    const recorder = await starting
    expect(recorder.frameCount).toBe(1)
    expect(spawnProcess).not.toHaveBeenCalled()
    await recorder.stop()
  })

  it('rejects without a CDP session when the spool cannot be opened', async () => {
    const spool = createFakeSpool()
    Object.assign(spool.stream, { pending: true })
    const page = createPage(createFakeSession())
    const starting = recordScreencast(page, spoolOptions, {
      openSpoolFile: spool.open,
    })
    await vi.waitFor(() => {
      expect(spool.open).toHaveBeenCalledOnce()
    })
    spool.stream.emit(
      'error',
      new Error("EEXIST: file already exists, open 'segment.spool.mkv'"),
    )

    await expect(starting).rejects.toThrow(
      "The frame spool could not be written: EEXIST: file already exists, open 'segment.spool.mkv'",
    )
    expect(page.createCDPSession).not.toHaveBeenCalled()
    expect(spool.stream.destroyed).toBe(true)
  })

  it('closes the spool when the screencast cannot start', async () => {
    const spool = createFakeSpool()
    const session = createFakeSession()
    vi.mocked(session.send).mockRejectedValueOnce(new Error('Target closed'))

    await expect(
      recordScreencast(createPage(session), spoolOptions, {
        openSpoolFile: spool.open,
      }),
    ).rejects.toThrow('Target closed')
    expect(spool.stream.destroyed).toBe(true)
    expect(session.detach).toHaveBeenCalled()
    expect(session.listenerCount('Page.screencastFrame')).toBe(0)
  })

  it('closes the spool when attachment times out', async () => {
    vi.useFakeTimers()
    const spool = createFakeSpool()
    const page = createPage(createFakeSession())
    vi.mocked(page.createCDPSession).mockReturnValue(new Promise(() => {}))
    const starting = recordScreencast(page, spoolOptions, {
      openSpoolFile: spool.open,
    })
    const rejected = expect(starting).rejects.toThrow(
      'CDP startup timed out after 10000ms',
    )
    try {
      await vi.advanceTimersByTimeAsync(10_001)
      await rejected
      expect(spool.stream.destroyed).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

const BUDGET_LIMITS: SpoolLimits = {
  promoteBytes: 1_000_000,
  hardCapBytes: 1_000_000,
  promoteFreeBytes: 0,
  stopFreeBytes: 0,
  freeCheckIntervalBytes: 1_000_000,
}

const createBudget = (
  limits: Partial<SpoolLimits> = {},
  freeBytes: () => Promise<number> = async () => Number.MAX_SAFE_INTEGER,
): SpoolBudget =>
  new SpoolBudget({ ...BUDGET_LIMITS, ...limits }, { freeBytes })

const LIMIT_REASON =
  /^The recording's frame spools reached the disk limit of \d+ bytes; capture stopped after \d+\.\ds to bound disk use\.$/u

// The labels shown, in order, once a recording has stopped.
const shownLabels = (frames: GridFrame[]): string[] => {
  return [...new Set(shown(frames))]
}

describe('screencast recorder spool budget', () => {
  it('stops at the hard cap with every earlier span intact and writes nothing past it', async () => {
    const header = (await startSpoolRecorder({ fps: 10 })).bytes().length
    const cap = header + 400
    const run = await startSpoolRecorder({
      budget: createBudget({ hardCapBytes: cap }),
      fps: 10,
    })
    const labels = ['start']
    for (
      let step = 1;
      step <= 60 && !run.recorder.incompleteReason;
      step += 1
    ) {
      const label = `f${step.toString().padStart(2, '0')}`
      run.frame(label, 100 + step / 10)
      await settle()
      if (!run.recorder.incompleteReason) {
        labels.push(label)
      }
    }
    expect(run.recorder.incompleteReason).toMatch(LIMIT_REASON)
    expect(run.session.listenerCount('Page.screencastFrame')).toBe(0)
    expect(run.session.sent).toContain('Page.stopScreencast')
    expect(labels.length).toBeGreaterThan(3)
    expect(labels.length).toBeLessThan(40)

    await run.recorder.stop()

    expect(run.bytes().length).toBeLessThanOrEqual(cap)
    // Every frame accepted before the cap still has its own span, in order.
    expect(shownLabels(run.frames(10))).toEqual(labels)
    expect(run.recorder.output.kind).toBe('spool')
  })

  it('stops a static page whose holds would pass the cap, and still ends the video', async () => {
    const clock = createHoldClock()
    const header = (await startSpoolRecorder({ fps: 10 })).bytes().length
    const cap = header + 350
    const run = await startSpoolRecorder(
      { budget: createBudget({ hardCapBytes: cap }), fps: 10 },
      undefined,
      clock,
    )
    for (
      let hold = 0;
      hold < 100 && !run.recorder.incompleteReason;
      hold += 1
    ) {
      run.advance(1_000)
      clock.tick()
      await settle()
    }
    expect(run.recorder.incompleteReason).toMatch(LIMIT_REASON)
    expect(clock.cleared()).toBe(true)

    run.advance(2_000)
    await run.recorder.stop()

    expect(run.bytes().length).toBeLessThanOrEqual(cap)
    expect(shownLabels(run.frames(10))).toEqual(['start'])
  })

  it('never lets what stopping writes carry the spool past the cap', async () => {
    const header = (await startSpoolRecorder({ fps: 10 })).bytes().length
    for (const room of [140, 150, 200, 260]) {
      const cap = header + room
      const run = await startSpoolRecorder({
        budget: createBudget({ hardCapBytes: cap }),
        fps: 10,
      })
      for (let step = 1; step <= 30; step += 1) {
        run.frame(`f${step.toString()}`, 100 + step / 10)
        await settle()
      }
      run.advance(5_000)
      await run.recorder.stop()
      expect(run.bytes().length).toBeLessThanOrEqual(cap)
    }
  })

  it('asks for promotion at the promote threshold and promotes later segments', async () => {
    const budget = createBudget({ promoteBytes: 400 })
    const header = (await startSpoolRecorder({ fps: 10 })).bytes().length
    const run = await startSpoolRecorder({ budget, fps: 10 })
    expect(budget.promoted).toBe(false)
    for (let step = 1; step <= 40; step += 1) {
      run.frame(`f${step.toString()}`, 100 + step / 10)
      await settle()
    }

    expect(header).toBeLessThan(400)
    expect(budget.promoted).toBe(true)
    // Until a segment can continue live, it keeps spooling.
    expect(run.recorder.incompleteReason).toBeUndefined()
    expect(run.recorder.output.kind).toBe('spool')
    await run.recorder.stop()
  })

  it('counts the sealed spools of the recording, so small segments reach the limit together', async () => {
    const budget = createBudget({ hardCapBytes: 1_200 })
    const sealedSizes: number[] = []
    for (let segment = 0; segment < 3; segment += 1) {
      const run = await startSpoolRecorder({ budget, fps: 10 })
      run.frame('a', 101)
      await settle()
      await run.recorder.stop()
      sealedSizes.push(run.bytes().length)
      expect(run.recorder.incompleteReason).toBeUndefined()
    }
    const sealed = sealedSizes.reduce((total, size) => total + size, 0)
    expect(budget.bytes).toBe(sealed)
    expect(sealed).toBeLessThan(1_200)

    // The fourth segment alone is nowhere near the cap; the recording is.
    const last = await startSpoolRecorder({ budget, fps: 10 })
    for (
      let step = 1;
      step <= 40 && !last.recorder.incompleteReason;
      step += 1
    ) {
      last.frame(`g${step.toString()}`, 100 + step / 10)
      await settle()
    }
    expect(last.recorder.incompleteReason).toMatch(LIMIT_REASON)
    await last.recorder.stop()
    expect(budget.bytes).toBeLessThanOrEqual(1_200)
    expect(last.bytes().length).toBeLessThan(1_200 - sealed + 1)
  })

  it('stops a spooling segment below the lower free-space floor', async () => {
    const budget = createBudget(
      { promoteFreeBytes: 2_000, stopFreeBytes: 500 },
      async () => 100,
    )
    const run = await startSpoolRecorder({ budget, fps: 10 })
    await vi.waitFor(() => {
      expect(run.recorder.incompleteReason).toBe(
        'Free disk space for the frame spool fell to 100 bytes, below the floor of 500 bytes; capture stopped after 0.0s to bound disk use.',
      )
    })

    expect(run.session.listenerCount('Page.screencastFrame')).toBe(0)
    expect(run.session.sent).toContain('Page.stopScreencast')
    expect(budget.promoted).toBe(true)
    await run.recorder.stop()
    expect(shownLabels(run.frames(10))).toEqual(['start'])
  })

  it('keeps recording when the free space is low but above the lower floor', async () => {
    const freeBytes = vi.fn(async () => 1_000)
    const budget = new SpoolBudget(
      { ...BUDGET_LIMITS, promoteFreeBytes: 2_000, stopFreeBytes: 500 },
      { freeBytes },
    )
    const run = await startSpoolRecorder({ budget, fps: 10 })
    await settle()

    expect(freeBytes).toHaveBeenCalledOnce()
    expect(run.recorder.incompleteReason).toBeUndefined()
    expect(budget.promoted).toBe(true)
    await run.recorder.stop()
  })

  it('keeps recording when the free space cannot be read', async () => {
    const budget = createBudget(
      {
        freeCheckIntervalBytes: 50,
        promoteFreeBytes: 2_000,
        stopFreeBytes: 500,
      },
      async () => {
        throw new Error('statfs failed')
      },
    )
    const run = await startSpoolRecorder({ budget, fps: 10 })
    for (let step = 1; step <= 20; step += 1) {
      run.frame(`f${step.toString()}`, 100 + step / 10)
      await settle()
    }

    expect(run.recorder.incompleteReason).toBeUndefined()
    expect(budget.promoted).toBe(false)
    await run.recorder.stop()
  })

  it('checks the free space again after each further interval written', async () => {
    const freeBytes = vi.fn(async () => Number.MAX_SAFE_INTEGER)
    const budget = new SpoolBudget(
      { ...BUDGET_LIMITS, freeCheckIntervalBytes: 100 },
      { freeBytes },
    )
    const run = await startSpoolRecorder({ budget, fps: 10 })
    await settle()
    expect(freeBytes).toHaveBeenCalledOnce()
    for (let step = 1; step <= 30; step += 1) {
      run.frame(`f${step.toString()}`, 100 + step / 10)
      await settle()
    }

    const written = run.bytes().length
    expect(freeBytes.mock.calls.length).toBeGreaterThan(1)
    expect(freeBytes.mock.calls.length).toBeLessThanOrEqual(
      1 + Math.floor(written / 100),
    )
    await run.recorder.stop()
  })

  it('leaves the budget when the segment fails to start', async () => {
    const budget = createBudget()
    const spool = createFakeSpool()
    const session = createFakeSession()
    vi.mocked(session.send).mockRejectedValueOnce(new Error('Target closed'))

    await expect(
      recordScreencast(
        createPage(session),
        { ...spoolOptions, budget },
        { openSpoolFile: spool.open },
      ),
    ).rejects.toThrow('Target closed')

    // The header was written before the failure; the spool is not kept.
    expect(budget.bytes).toBe(0)
  })

  it('does not bound an encoder sink', async () => {
    const budget = createBudget({ hardCapBytes: 1 })
    const run = await startRecorder({ fps: 10 })
    run.frame('a', 101)
    await settle()

    expect(budget.bytes).toBe(0)
    expect(run.recorder.incompleteReason).toBeUndefined()
    await run.recorder.stop()
  })
})

// A hold clock whose delays the test ends: the stop's wait for a frame on its
// way never depends on wall time.
const createTailClock = () => {
  const delays = createControlledDelays()
  const clock = { ...createHoldClock(), delay: delays.delay }
  return { clock, delays }
}

describe('screencast recorder tail frame at stop', () => {
  it('waits a quiet gap after a lone frame on its way, placed by its own timestamp', async () => {
    const { clock, delays } = createTailClock()
    const run = await startRecorder({ fps: 10 }, 100, undefined, clock)
    // The page is static for a second, then the test stops right after a
    // paint whose frame Chrome is still capturing.
    run.advance(1_000)
    const stopping = run.recorder.stop()
    await settle()
    expect(run.session.sent).not.toContain('Page.stopScreencast')
    expect(delays.requested.map((delay) => delay.milliseconds)).toEqual([
      TAIL_FRAME_WAIT_MS,
    ])

    // Painted at 0.9 s, delivered 150 ms later, during the wait. Another
    // frame may follow it, so the wait goes on for a quiet gap.
    run.advance(50)
    run.session.emitFrame('tail', 100.9)
    await settle()
    expect(run.session.sent).not.toContain('Page.stopScreencast')
    expect(delays.requested.map((delay) => delay.milliseconds)).toEqual([
      TAIL_FRAME_WAIT_MS,
      TAIL_FRAME_QUIET_MS,
    ])

    run.advance(TAIL_FRAME_QUIET_MS)
    delays.requested[1]?.resolve()
    await stopping

    expect(run.session.sent).toContain('Page.stopScreencast')
    // Shown from 0.9 s, where it was painted, and held to the stop at 1.15 s.
    expect(shown(run.frames(10))).toEqual([
      ...Array.from({ length: 9 }, () => 'start'),
      'tail',
      'tail',
      'tail',
    ])
    // The bound's timer is released rather than left to run out.
    expect(delays.requested[0]?.signal?.aborted).toBe(true)
  })

  it('waits for a second frame in flight behind an older paint', async () => {
    const { clock, delays } = createTailClock()
    const run = await startRecorder({ fps: 10 }, 100, undefined, clock)
    run.advance(1_000)
    const stopping = run.recorder.stop()
    await settle()

    // The pointer moved over the button at 0.9 s; the click's paint at 1 s is
    // right behind it. Neither delay is expired: two frames end the wait.
    run.advance(20)
    run.session.emitFrame('pointer', 100.9)
    run.advance(16)
    run.session.emitFrame('paint', 101)
    await stopping

    expect(run.session.sent).toContain('Page.stopScreencast')
    expect(shown(run.frames(10))).toEqual([
      ...Array.from({ length: 9 }, () => 'start'),
      'pointer',
      'paint',
    ])
    // Every timer of the wait is released.
    expect(delays.requested.map((delay) => delay.signal?.aborted)).toEqual([
      true,
      true,
    ])
  })

  it('stops at the second frame without waiting for a third', async () => {
    const { clock, delays } = createTailClock()
    const run = await startRecorder({ fps: 10 }, 100, undefined, clock)
    run.advance(500)
    const stopping = run.recorder.stop()
    await settle()

    // An animating page: two frames end the wait, and the screencast is
    // stopped before the next frame Chrome would send.
    run.frame('first', 100.52)
    run.frame('second', 100.62)
    await settle()
    expect(run.session.sent).toContain('Page.stopScreencast')
    await stopping
    run.frame('third', 100.72)

    expect(delays.requested).toHaveLength(2)
    expect(shownLabels(run.frames(10))).toEqual(['start', 'first', 'second'])
    expect(run.recorder.frameCount).toBe(3)
  })

  it('counts only frames it captures toward the wait', async () => {
    const { clock, delays } = createTailClock()
    const run = await startRecorder({ fps: 10 }, 100, undefined, clock)
    run.advance(1_000)
    const stopping = run.recorder.stop()
    await settle()

    // Two events without a timestamp are acknowledged but not captured, so
    // they neither end the wait nor start its quiet gap.
    run.advance(10)
    run.session.emitFrame('missing')
    run.session.emitFrame('missing')
    await settle()
    expect(run.session.sent).not.toContain('Page.stopScreencast')
    expect(delays.requested).toHaveLength(1)

    // The paint arrives before either timer has run out.
    run.advance(20)
    run.session.emitFrame('paint', 100.9)
    await settle()
    expect(run.session.sent).not.toContain('Page.stopScreencast')
    delays.requested[1]?.resolve()
    await stopping

    const acks = run.session.sent.filter(
      (method) => method === 'Page.screencastFrameAck',
    )
    // The first frame, both events without a timestamp and the paint.
    expect(acks).toHaveLength(4)
    expect(run.session.sent.indexOf('Page.stopScreencast')).toBeGreaterThan(
      run.session.sent.lastIndexOf('Page.screencastFrameAck'),
    )
    expect(shownLabels(run.frames(10))).toEqual(['start', 'paint'])
    expect(run.recorder.frameCount).toBe(2)
  })

  it('ends at the bound however slowly frames trickle in', async () => {
    const { clock, delays } = createTailClock()
    const run = await startRecorder({ fps: 10 }, 100, undefined, clock)
    run.advance(1_000)
    const stopping = run.recorder.stop()
    await settle()

    // A frame late in the wait starts a quiet gap that would outlast the
    // bound; the bound ends the wait first.
    run.advance(100)
    run.session.emitFrame('slow', 100.95)
    await settle()
    run.advance(TAIL_FRAME_WAIT_MS - 100)
    delays.requested[0]?.resolve()
    await stopping

    expect(run.session.sent).toContain('Page.stopScreencast')
    expect(delays.requested[1]?.signal?.aborted).toBe(true)
    expect(shownLabels(run.frames(10))).toEqual(['start', 'slow'])
  })

  it('waits the whole bound on a page that does not change, then stops', async () => {
    const { clock, delays } = createTailClock()
    const run = await startRecorder({ fps: 10 }, 100, undefined, clock)
    run.advance(1_000)
    const stopped = vi.fn()
    const stopping = run.recorder.stop().then(stopped)
    await settle()
    expect(stopped).not.toHaveBeenCalled()
    expect(run.session.sent).not.toContain('Page.stopScreencast')

    run.advance(TAIL_FRAME_WAIT_MS)
    delays.expire()
    await stopping

    expect(run.session.sent).toContain('Page.stopScreencast')
    // The final frame is held to where the stop ended, the wait included.
    expect(spanCounts(run.frames(10))).toEqual({ start: 11 })
  })

  it('does not wait once overload has stopped capture', async () => {
    const { clock, delays } = createTailClock()
    const run = await startRecorder(
      { fps: 10 },
      100,
      createFakeFfmpeg(),
      clock,
      { maxPendingBytes: 20 },
    )
    run.frame('next', 101)
    run.frame('y'.repeat(30), 101.04)
    expect(run.recorder.incompleteReason).toContain('exceeds 20 bytes')

    await run.recorder.stop()

    expect(delays.requested).toEqual([])
  })

  it('does not wait once the spool budget has stopped capture', async () => {
    const { clock, delays } = createTailClock()
    const header = (await startSpoolRecorder({ fps: 10 })).bytes().length
    const run = await startSpoolRecorder(
      { budget: createBudget({ hardCapBytes: header + 400 }), fps: 10 },
      undefined,
      clock,
    )
    for (
      let step = 1;
      step <= 60 && !run.recorder.incompleteReason;
      step += 1
    ) {
      run.frame(`f${step.toString()}`, 100 + step / 10)
      await settle()
    }
    expect(run.recorder.incompleteReason).toMatch(LIMIT_REASON)

    await run.recorder.stop()

    expect(delays.requested).toEqual([])
  })

  it('does not wait once the encoder has exited', async () => {
    const { clock, delays } = createTailClock()
    const run = await startRecorder(
      { fps: 10 },
      100,
      createStalledFfmpeg(),
      clock,
    )
    run.frame('a', 101)
    Object.assign(run.child, { exitCode: 1 })
    run.child.stdin?.destroy()
    run.child.emit('exit', 1)
    run.child.emit('close', 1)
    await settle()

    await run.recorder.stop()

    expect(delays.requested).toEqual([])
    expect(run.recorder.incompleteReason).toContain('FFmpeg exited with code 1')
  })

  it('ends the wait when the encoder exits during it', async () => {
    const { clock, delays } = createTailClock()
    const run = await startRecorder(
      { fps: 10 },
      100,
      createStalledFfmpeg(),
      clock,
    )
    const stopping = run.recorder.stop()
    await settle()
    expect(delays.requested).toHaveLength(1)

    // Never expired: a closed encoder has nowhere to put another frame.
    Object.assign(run.child, { exitCode: 1 })
    run.child.stdin?.destroy()
    run.child.emit('exit', 1)
    run.child.emit('close', 1)
    await stopping

    expect(delays.requested[0]?.signal?.aborted).toBe(true)
    expect(run.recorder.incompleteReason).toContain('FFmpeg exited with code 1')
  })

  it('lets an abort during the wait win at once', async () => {
    const { clock, delays } = createTailClock()
    const run = await startRecorder({ fps: 10 }, 100, undefined, clock)
    const stopping = run.recorder.stop()
    await settle()
    expect(delays.requested).toHaveLength(1)

    // Never expired: the abort alone ends the wait and the stop.
    await run.recorder.abort()
    await stopping

    expect(delays.requested[0]?.signal?.aborted).toBe(true)
    expect(run.kill).toHaveBeenCalled()
    expect(run.frames(10)).toEqual([])
  })

  it.each([
    ['an abort', (recorder: ScreencastRecorder) => recorder.abort()],
    [
      'a stop whose media is thrown away',
      (recorder: ScreencastRecorder) => recorder.stop({ tailFrame: false }),
    ],
  ])('does not wait for %s', async (_name, end) => {
    const { clock, delays } = createTailClock()
    const run = await startRecorder({ fps: 10 }, 100, undefined, clock)

    await end(run.recorder)

    expect(delays.requested).toEqual([])
    expect(run.session.listenerCount('Page.screencastFrame')).toBe(0)
  })

  it('gives a spool the frame that arrives during the wait', async () => {
    const { clock, delays } = createTailClock()
    const run = await startSpoolRecorder({ fps: 10 }, undefined, clock)
    run.advance(1_000)
    const stopping = run.recorder.stop()
    await settle()
    expect(delays.requested).toHaveLength(1)

    run.advance(50)
    run.session.emitFrame('tail', 100.9)
    await settle()
    // No frame follows within the quiet gap.
    delays.requested[1]?.resolve()
    await stopping

    expect(shown(run.frames(10))).toEqual([
      ...Array.from({ length: 9 }, () => 'start'),
      'tail',
      'tail',
    ])
    expect(run.recorder.output.kind).toBe('spool')
  })

  it('stays far inside the engine stop timeout', () => {
    expect(RECORDER_STOP_TIMEOUT_MS).toBeGreaterThanOrEqual(
      20 * TAIL_FRAME_WAIT_MS,
    )
  })
})

// A budget that counts how often each registered segment's byte count is read.
const createCountingBudget = (limits: Partial<SpoolLimits> = {}) => {
  const budget = createBudget(limits)
  const reads: number[] = []
  const begin = budget.beginSegment.bind(budget)
  vi.spyOn(budget, 'beginSegment').mockImplementation((directory, bytes) => {
    const index = reads.push(0) - 1
    return begin(directory, () => {
      reads[index] = (reads[index] ?? 0) + 1
      return bytes()
    })
  })
  return { budget, reads }
}

// Frames a later segment captures, each one a budget check.
const captureFrames = async (
  run: Awaited<ReturnType<typeof startSpoolRecorder>>,
  count: number,
): Promise<void> => {
  for (let step = 1; step <= count; step += 1) {
    run.frame(`g${step.toString()}`, 100 + step / 10)
    await settle()
  }
}

describe('screencast recorder sealed spools', () => {
  it('seals a stopped spool: later segments count its final bytes without reading it', async () => {
    const { budget, reads } = createCountingBudget()
    const first = await startSpoolRecorder({ budget, fps: 10 })
    first.frame('a', 101)
    await settle()
    await first.recorder.stop()
    const readsAtStop = reads[0]

    const second = await startSpoolRecorder({ budget, fps: 10 })
    await captureFrames(second, 30)
    await second.recorder.stop()

    expect(reads[0]).toBe(readsAtStop)
    expect(reads[1]).toBeGreaterThan(0)
    expect(budget.bytes).toBe(first.bytes().length + second.bytes().length)
  })

  it('seals a spool stopped at the hard cap only once stopping has written its last blocks', async () => {
    const clock = createHoldClock()
    const header = (await startSpoolRecorder({ fps: 10 })).bytes().length
    const { budget, reads } = createCountingBudget({
      hardCapBytes: header + 350,
    })
    const run = await startSpoolRecorder({ budget, fps: 10 }, undefined, clock)
    for (
      let hold = 0;
      hold < 100 && !run.recorder.incompleteReason;
      hold += 1
    ) {
      run.advance(1_000)
      clock.tick()
      await settle()
    }
    expect(run.recorder.incompleteReason).toMatch(LIMIT_REASON)
    const atLimit = run.bytes().length
    run.advance(2_000)
    await run.recorder.stop()
    const readsAtStop = reads[0]

    // Stopping still wrote the end of the video, and that is counted.
    expect(run.bytes().length).toBeGreaterThan(atLimit)
    expect(budget.bytes).toBe(run.bytes().length)
    const later = await startSpoolRecorder({ budget, fps: 10 })
    await captureFrames(later, 5)
    await later.recorder.stop()
    expect(reads[0]).toBe(readsAtStop)
  })

  it('seals an aborted spool', async () => {
    const { budget, reads } = createCountingBudget()
    const run = await startSpoolRecorder({ budget, fps: 10 })
    run.frame('a', 101)
    await settle()
    await run.recorder.abort()
    const total = budget.bytes
    const readsAtAbort = reads[0]

    const later = await startSpoolRecorder({ budget, fps: 10 })
    await captureFrames(later, 5)
    await later.recorder.stop()

    expect(reads[0]).toBe(readsAtAbort)
    expect(total).toBeGreaterThan(0)
    expect(budget.bytes).toBe(total + later.bytes().length)
  })

  it('seals a spool that could not be written', async () => {
    const { budget, reads } = createCountingBudget()
    const run = await startSpoolRecorder(
      { budget, fps: 10 },
      createFakeSpool(3),
      createHoldClock(),
    )
    run.frame('a', 101)
    await vi.waitFor(() => {
      expect(run.recorder.incompleteReason).toMatch(/ENOSPC/u)
    })
    await settle()
    const readsAtFailure = reads[0]

    const later = await startSpoolRecorder({ budget, fps: 10 })
    await captureFrames(later, 5)
    await run.recorder.stop()
    await later.recorder.stop()

    expect(reads[0]).toBe(readsAtFailure)
  })
})
