import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { CDPSession, Page } from 'puppeteer-core'
import { describe, expect, it } from 'vitest'
import { systemClock } from '../../src/service/boundaries.js'
import type { SpoolFileStream } from '../../src/service/frame-sink.js'
import { recordScreencast } from '../../src/service/screencast-recorder.js'

// A clock whose timers fire only when the test advances it.
const createClock = () => {
  let elapsed = 0
  let nextTimer = 0
  const timers = new Map<number, { due: number; callback: () => void }>()
  const handle = (id: number) =>
    ({ id, unref() {} }) as unknown as NodeJS.Timeout
  return {
    clock: {
      ...systemClock,
      setTimeout(callback: () => void, milliseconds: number) {
        nextTimer += 1
        timers.set(nextTimer, { due: elapsed + milliseconds, callback })
        return handle(nextTimer)
      },
      clearTimeout(timer: NodeJS.Timeout) {
        timers.delete((timer as unknown as { id: number }).id)
      },
      setInterval() {
        nextTimer += 1
        return handle(nextTimer)
      },
      clearInterval() {},
    },
    advance(milliseconds: number) {
      elapsed += milliseconds
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.due <= elapsed) {
          timers.delete(id)
          timer.callback()
        }
      }
    },
    now: () => elapsed,
    pendingTimers: () => timers.size,
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

const createPage = () => {
  const session = Object.assign(new EventEmitter(), {
    detach: async () => {},
    send: async (method: string) => {
      if (method === 'Page.startScreencast') {
        session.emit('Page.screencastFrame', {
          data: Buffer.from('frame').toString('base64'),
          metadata: { timestamp: 1 },
          sessionId: 1,
        })
      }
      return {}
    },
  })
  const state = { attachments: 0 }
  const page = Object.assign(new EventEmitter(), {
    viewport: () => null,
    evaluate: async () => ({ width: 64, height: 64, devicePixelRatio: 1 }),
    createCDPSession: async () => {
      state.attachments += 1
      return session as unknown as CDPSession
    },
  })
  return { page: page as unknown as Page, state }
}

// A spool file whose open stays pending until the test emits `ready`.
const createPendingSpoolFile = (closes = true) =>
  Object.assign(
    new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
      destroy(error, callback) {
        if (closes) {
          callback(error)
        }
      },
    }),
    { pending: true, bytesWritten: 0 },
  ) as SpoolFileStream

const spoolOptions = {
  ffmpegPath: 'unused',
  format: 'webm',
  fps: 10,
  quality: 30,
  scale: 1,
  speed: 1,
  spoolPath: 'pending-spool.mkv',
} as const

// Records how the startup promise settled without leaving it unhandled.
const track = (starting: Promise<unknown>) => {
  const outcome: { state: string; error?: Error } = { state: 'pending' }
  starting.then(
    () => {
      outcome.state = 'started'
    },
    (error: Error) => {
      outcome.state = 'failed'
      outcome.error = error
    },
  )
  return outcome
}

describe('screencast startup waits a bounded time for its output', () => {
  it('fails a spool whose file never opens, without attaching to the page', async () => {
    const time = createClock()
    const { page, state } = createPage()
    const file = createPendingSpoolFile()
    const outcome = track(
      recordScreencast(page, spoolOptions, {
        clock: time.clock,
        monotonicNow: time.now,
        openSpoolFile: () => file,
      }),
    )
    await settle()
    expect(outcome.state).toBe('pending')
    expect(time.pendingTimers()).toBe(1)

    time.advance(10_000)
    await settle()

    expect(outcome.state).toBe('failed')
    expect(outcome.error?.message).toBe(
      'Screencast startup timed out after 10000ms opening the frame spool',
    )
    expect(state.attachments).toBe(0)
    expect(file.destroyed).toBe(true)

    // A file that opens after the deadline cannot restart the capture.
    file.emit('ready')
    await settle()
    expect(state.attachments).toBe(0)
    expect(outcome.state).toBe('failed')
  })

  it('starts when the spool file opens within the deadline, and clears the deadline', async () => {
    const time = createClock()
    const { page, state } = createPage()
    const file = createPendingSpoolFile()
    const starting = recordScreencast(page, spoolOptions, {
      clock: time.clock,
      monotonicNow: time.now,
      openSpoolFile: () => file,
    })
    await settle()
    time.advance(5_000)
    file.emit('ready')

    const recorder = await starting
    expect(state.attachments).toBe(1)
    expect(recorder.frameCount).toBe(1)

    // Neither startup deadline is left armed to cancel a running recording.
    time.advance(60_000)
    await settle()
    expect(recorder.incompleteReason).toBeUndefined()
    await recorder.abort()
  })

  it('bounds the cleanup when the timed-out spool file is slow to close', async () => {
    const time = createClock()
    const { page } = createPage()
    const file = createPendingSpoolFile(false)
    const outcome = track(
      recordScreencast(page, spoolOptions, {
        clock: time.clock,
        monotonicNow: time.now,
        openSpoolFile: () => file,
      }),
    )
    await settle()
    time.advance(10_000)
    await settle()
    // The abort is waiting for a close that has not come.
    expect(outcome.state).toBe('pending')

    time.advance(1_000)
    await settle()
    expect(outcome.state).toBe('failed')
    expect(outcome.error?.message).toContain('opening the frame spool')
  })

  it('fails an encoder that never spawns, without attaching to the page', async () => {
    const time = createClock()
    const { page, state } = createPage()
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: () => true,
      pid: undefined,
      signalCode: null,
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      unref() {},
    }) as unknown as ChildProcess
    const outcome = track(
      recordScreencast(
        page,
        {
          ffmpegPath: 'ffmpeg',
          format: 'webm',
          fps: 10,
          outputPath: 'never.webm',
          quality: 30,
          scale: 1,
          speed: 1,
        },
        {
          clock: time.clock,
          monotonicNow: time.now,
          spawnProcess: () => child,
          terminateProcessTree: async () => {},
        },
      ),
    )
    await settle()
    time.advance(10_000)
    await settle()
    // The encoder's own bounded wait for its process to close.
    time.advance(1_000)
    await settle()

    expect(outcome.state).toBe('failed')
    expect(outcome.error?.message).toBe(
      'Screencast startup timed out after 10000ms starting the encoder',
    )
    expect(state.attachments).toBe(0)
  })
})
