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
  ScreencastRecorder,
  type ScreencastRecorderOptions,
} from '../../src/service/screencast-recorder.js'

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

const createFakeFfmpeg = (
  closeOnEnd = true,
): {
  child: ChildProcess
  kill: ReturnType<typeof vi.fn>
  spawn: () => ChildProcess
  writes: string[]
} => {
  const writes: string[] = []
  const child = new EventEmitter() as ChildProcess & {
    exitCode: number | null
    signalCode: NodeJS.Signals | null
  }
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      writes.push(chunk.toString())
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
      child.exitCode = 0
      child.emit('close', 0)
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
  return { child, kill, spawn, writes }
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
  tick: () => void
} => {
  let tick: (() => void) | undefined
  let cleared = false
  return {
    ...createClock(),
    clearInterval: () => {
      cleared = true
    },
    cleared: () => cleared,
    setInterval: (callback) => {
      tick = callback
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
  ffmpeg = createFakeFfmpeg(),
  clock: ClockBoundary = createClock(),
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

const countWrites = (writes: string[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const label of writes) {
    counts[label] = (counts[label] ?? 0) + 1
  }
  return counts
}

describe('screencast recorder FFmpeg arguments', () => {
  it('declares the input frame rate before the input and keeps probing intact', () => {
    const args = createFfmpegArguments(
      options,
      { width: 1280, height: 720 },
      undefined,
    )
    // FFmpeg ignores `-framerate` after `-i` and plays piped images at 25 fps.
    expect(args.indexOf('-framerate')).toBeLessThan(args.indexOf('-i'))
    expect(args[args.indexOf('-framerate') + 1]).toBe('30')
    // Unbuffered input or a tiny probe makes FFmpeg lose the first two frames.
    for (const flag of [
      '-avioflags',
      '-probesize',
      '-fpsprobesize',
      '-analyzeduration',
      '-fflags',
    ]) {
      expect(args).not.toContain(flag)
    }
    expect(args.slice(args.indexOf('-f', args.indexOf('-i')))).toEqual(
      expect.arrayContaining(['-f', 'webm']),
    )
    expect(args.at(-1)).toBe('pipe:1')
  })

  it('applies speed, crop and scale in the same filter order as Puppeteer', () => {
    const args = createFfmpegArguments(
      { ...options, format: 'mp4', scale: 0.5, speed: 2 },
      { width: 1600, height: 900 },
      { x: 20, y: 40, width: 800, height: 400 },
    )
    expect(args[args.indexOf('-vf') + 1]).toBe(
      "crop='min(1600,iw):min(900,ih):0:0',pad=1600:900:0:0,setpts=0.5*PTS,crop=800:400:20:40,scale=iw*0.5:-1:flags=lanczos",
    )
    expect(args).toEqual(
      expect.arrayContaining(['-movflags', 'hybrid_fragmented']),
    )
    expect(args[args.indexOf('-f', args.indexOf('-i')) + 1]).toBe('mp4')
  })

  it('omits the speed and scale filters when they are not set', () => {
    const args = createFfmpegArguments(
      { format: 'webm', fps: 30, quality: 30 },
      { width: 1280, height: 720 },
      undefined,
    )
    expect(args[args.indexOf('-vf') + 1]).toBe(
      "crop='min(1280,iw):min(720,ih):0:0',pad=1280:720:0:0",
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

describe('screencast recorder frame timing', () => {
  it('keeps real-time duration when Chrome captures faster than the frame rate', async () => {
    // Puppeteer rounds each 10 ms gap to zero at 24 FPS and writes nothing.
    const harness = await startRecorder({ fps: 24 }, 100)
    for (let frame = 1; frame <= 100; frame += 1) {
      harness.frame(`f${frame}`, 100 + frame * 0.01)
    }
    expect(harness.writes).toHaveLength(24)
    // Distinct content survives rather than one frame repeated.
    expect(new Set(harness.writes).size).toBeGreaterThan(20)
    expect(harness.recorder.frameCount).toBe(101)
  })

  it('duplicates sparse frames to fill the time between them', async () => {
    const harness = await startRecorder({ fps: 30 }, 100)
    harness.frame('half', 100.5)
    harness.frame('one', 101)
    expect(countWrites(harness.writes)).toEqual({ half: 15, start: 15 })
  })

  it('does not stretch a recording whose first frame carries a stale timestamp', async () => {
    // Chrome stamped the first frame with a paint from 10 s before capture.
    const harness = await startRecorder({ fps: 10 }, 90)
    harness.advance(100)
    harness.session.emitFrame('next', 100.1)
    // It arrived 0.1 s after the first frame, so it is shown 0.35 s in, not 10.1 s.
    expect(countWrites(harness.writes)).toEqual({ start: 4 })

    harness.advance(100)
    harness.session.emitFrame('later', 100.2)
    harness.advance(1_000)
    await harness.recorder.stop()
    // "later" is shown 0.45 s in and held for the 1 s until stop: 1.5 s in all.
    expect(countWrites(harness.writes)).toEqual({
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
    expect(harness.recorder.frameCount).toBe(3)
    // The backwards frame is treated as simultaneous with the first one.
    expect(countWrites(harness.writes)).toEqual({ backwards: 10 })
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

  it('feeds a long quiet tail to the encoder while recording, not at stop', async () => {
    // Chrome sends nothing while a page is static. Writing the whole tail at
    // stop left 60 s of full-HD video to encode inside a 5 s deadline.
    const clock = createHoldClock()
    const harness = await startRecorder({ fps: 10 }, 100, undefined, clock)
    for (let second = 1; second <= 60; second += 1) {
      harness.advance(1_000)
      clock.tick()
    }
    // Held half a second behind real time so late frames keep their place.
    expect(harness.writes).toHaveLength(595)

    await harness.recorder.stop()

    expect(harness.writes).toHaveLength(600)
    expect(new Set(harness.writes)).toEqual(new Set(['start']))
    expect(clock.cleared()).toBe(true)
  })

  it('continues the timeline when a quiet page becomes active again', async () => {
    const clock = createHoldClock()
    const harness = await startRecorder({ fps: 10 }, 100, undefined, clock)
    harness.advance(10_000)
    clock.tick()
    expect(harness.writes).toHaveLength(95)

    harness.frame('active', 110)
    harness.advance(1_000)
    clock.tick()
    await harness.recorder.stop()

    // No frame is repeated or rewound across the transition.
    expect(countWrites(harness.writes)).toEqual({ active: 10, start: 100 })
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
    expect(countWrites(harness.writes)).toEqual({ late: 15, start: 95 })
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
    expect(harness.writes).toEqual([
      'start',
      ...late.slice(0, -1),
      ...Array.from({ length: 10 }, () => 'f50'),
    ])
  })

  it('leaves held frames for stop while the encoder is backed up', async () => {
    const clock = createHoldClock()
    const harness = await startRecorder({ fps: 10 }, 100, undefined, clock)
    const stdin = harness.child.stdin as NonNullable<ChildProcess['stdin']>
    Object.defineProperty(stdin, 'writableNeedDrain', { value: true })
    harness.advance(10_000)
    clock.tick()
    expect(harness.writes).toEqual([])

    await harness.recorder.stop()

    expect(harness.writes).toHaveLength(100)
  })

  it('stops holding frames once the recording is aborted', async () => {
    const clock = createHoldClock()
    const harness = await startRecorder({ fps: 10 }, 100, undefined, clock)

    await harness.recorder.abort()
    harness.advance(10_000)
    clock.tick()

    expect(clock.cleared()).toBe(true)
    expect(harness.writes).toEqual([])
  })

  it('holds the last received frame until stop, measured on the local clock', async () => {
    const harness = await startRecorder({ fps: 10 }, 100)
    harness.frame('last', 100.2)
    harness.advance(1_000)

    await harness.recorder.stop()

    // 0.2 s of "start", then "last" from 0.2 s until 1.2 s. Puppeteer would
    // drop "last" and repeat "start" instead.
    expect(countWrites(harness.writes)).toEqual({ last: 10, start: 2 })
    expect(harness.session.sent).toContain('Page.stopScreencast')
    expect(harness.session.detach).toHaveBeenCalled()
  })

  it('writes a lone frame at least once and stops only once', async () => {
    const harness = await startRecorder({ fps: 30 }, 100)

    await Promise.all([harness.recorder.stop(), harness.recorder.stop()])
    harness.session.emitFrame('after-stop', 105)

    expect(harness.writes).toEqual(['start'])
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

    expect(ffmpeg.writes).toEqual([])
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

    expect(harness.writes).toEqual([])
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
    expect(harness.writes).toEqual([])
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
    expect(harness.writes).toEqual([])
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

  it('bounds cleanup when a terminated process never reports close', async () => {
    vi.useFakeTimers()
    const ffmpeg = createFakeFfmpeg(false)
    const terminateProcessTree = vi.fn(async () => {})
    const recorder = new ScreencastRecorder(
      createFakeSession(),
      ffmpeg.child,
      30,
      () => 0,
      { clock: systemClock, terminateProcessTree },
    )
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
    } finally {
      vi.useRealTimers()
      recorder.destroy()
    }
  })
})

describe('screencast recorder startup', () => {
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
