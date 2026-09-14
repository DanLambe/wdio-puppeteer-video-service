import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { CDPSession, Page, Viewport } from 'puppeteer-core'
import { describe, expect, it, vi } from 'vitest'
import type { ClockBoundary } from '../../src/service/boundaries.js'
import {
  createFfmpegArguments,
  recordScreencast,
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

const createFakeFfmpeg = (): {
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
  stdin.on('finish', close)
  const kill = vi.fn(() => {
    close()
    return true
  })
  Object.assign(child, {
    exitCode: null,
    kill,
    signalCode: null,
    stdin,
    stdout,
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

// Starts a recorder whose screencast delivers frame "start" at `timestamp` as
// soon as it starts, with a controllable monotonic clock in milliseconds.
const startRecorder = async (
  recorderOptions: Partial<ScreencastRecorderOptions> = {},
  startTimestamp = 100,
) => {
  const ffmpeg = createFakeFfmpeg()
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
      clock: createClock(),
      cpuCount: () => 8,
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
      8,
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
      8,
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
      8,
    )
    expect(args[args.indexOf('-vf') + 1]).toBe(
      "crop='min(1280,iw):min(720,ih):0:0',pad=1280:720:0:0",
    )
  })
  it.each([
    [1, '1'],
    [3, '1'],
    [8, '4'],
    [64, '8'],
  ])('uses a whole-number VP9 speed for %i CPUs', (cpus, expected) => {
    const args = createFfmpegArguments(
      options,
      { width: 10, height: 10 },
      undefined,
      cpus,
    )
    expect(args[args.indexOf('-cpu-used') + 1]).toBe(expected)
  })
})

describe('screencast recorder frame timing', () => {
  it('keeps real-time duration when Chrome captures faster than the frame rate', async () => {
    // Puppeteer rounds each 10 ms gap to zero at 24 FPS and writes nothing.
    const harness = await startRecorder({ fps: 24 }, 100)
    for (let frame = 1; frame <= 100; frame += 1) {
      harness.session.emitFrame(`f${frame}`, 100 + frame * 0.01)
    }
    expect(harness.writes).toHaveLength(24)
    // Distinct content survives rather than one frame repeated.
    expect(new Set(harness.writes).size).toBeGreaterThan(20)
    expect(harness.recorder.frameCount).toBe(101)
  })

  it('duplicates sparse frames to fill the time between them', async () => {
    const harness = await startRecorder({ fps: 30 }, 100)
    harness.session.emitFrame('half', 100.5)
    harness.session.emitFrame('one', 101)
    expect(countWrites(harness.writes)).toEqual({ half: 15, start: 15 })
  })

  it('ignores frames without a finite timestamp and never rewinds the grid', async () => {
    const harness = await startRecorder({ fps: 10 }, 100)
    harness.session.emitFrame('missing')
    harness.session.emitFrame('text', '101')
    harness.session.emitFrame('nan', Number.NaN)
    harness.session.emitFrame('backwards', 99)
    harness.session.emitFrame('later', 101)
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

  it('holds the last received frame until stop, measured on the local clock', async () => {
    const harness = await startRecorder({ fps: 10 }, 100)
    harness.advance(200)
    harness.session.emitFrame('last', 100.2)
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
  it('stops FFmpeg and the CDP session when destroyed', async () => {
    const harness = await startRecorder()

    harness.recorder.destroy()

    expect(harness.kill).toHaveBeenCalledTimes(1)
    expect(harness.session.detach).toHaveBeenCalled()
    harness.session.emitFrame('ignored', 200)
    expect(harness.writes).toEqual([])
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
