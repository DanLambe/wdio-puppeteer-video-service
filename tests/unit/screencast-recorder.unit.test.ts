import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { CDPSession, Page, Viewport } from 'puppeteer-core'
import { describe, expect, it, vi } from 'vitest'
import {
  type ClockBoundary,
  systemClock,
} from '../../src/service/boundaries.js'
import {
  createFfmpegArguments,
  recordScreencast,
  resolveCaptureCanvas,
  ScreencastRecorder,
  type ScreencastRecorderOptions,
} from '../../src/service/screencast-recorder.js'
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
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = new Writable({
    ...(highWaterMark === undefined ? {} : { highWaterMark }),
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  let closing = false
  // Like a real process, output ends before the exit is reported.
  const close = (): void => {
    if (closing) {
      return
    }
    closing = true
    stdout.end()
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
    stdout,
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
  recorder.resume()
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
  return new ScreencastRecorder({
    canvas: { width: 1280, height: 720 },
    ffmpeg: ffmpeg.child,
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
    expect(args.at(-1)).toBe('pipe:1')
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
      { format: 'webm', quality: 30 },
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
      { format: 'webm', quality: 30, scale: 1 },
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
  const stdout = new PassThrough()
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
    stdout.end()
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
    stdout,
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
  ;(child.stdout as PassThrough).end()
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
    recorder.resume()

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

    // FFmpeg's output ended, so the recorder stream closed and stopped listening.
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

  it('stops FFmpeg and the CDP session when destroyed', async () => {
    const harness = await startRecorder()

    harness.recorder.destroy()
    await harness.recorder.abort()

    expect(harness.kill).toHaveBeenCalledTimes(1)
    expect(harness.session.detach).toHaveBeenCalled()
    harness.session.emitFrame('ignored', 200)
    expect(harness.frames(10)).toEqual([])
  })

  it('terminates the encoder when destroyed during a stalled CDP stop', async () => {
    const harness = await startRecorder()
    const { promise: stalledStop, resolve: finishLate } =
      Promise.withResolvers<never>()
    vi.mocked(harness.session.send).mockImplementation(() => stalledStop)
    const stopping = harness.recorder.stop()

    harness.recorder.destroy()
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
    expect(harness.child.stdout?.destroyed).toBe(true)
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
    const recorder = new ScreencastRecorder({
      canvas: { width: 1280, height: 720 },
      clock: systemClock,
      ffmpeg: ffmpeg.child,
      fps: 30,
      monotonicNow: () => 0,
      session: createFakeSession(),
      terminateProcessTree,
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
      expect(ffmpeg.child.stdout?.destroyed).toBe(true)
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
      recorder.destroy()
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
      expect(ffmpeg.child.stdout?.destroyed).toBe(true)
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
