import { type ChildProcess, spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import type { CDPSession, Page } from 'puppeteer-core'
import { expect, it, vi } from 'vitest'
import { nodeProcess, systemClock } from '../../src/service/boundaries.js'
import { terminateFfmpegProcessTree } from '../../src/service/process-supervisor.js'
import { recordScreencast } from '../../src/service/screencast-recorder.js'

// A wrapper and its encoder child exercise real tree ownership. On Windows
// detachment prevents libuv's job cleanup from hiding a single-process kill;
// on POSIX the descendant stays in its wrapper's owned process group.
const wrapperProgram = `
const { spawn } = require('node:child_process')
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
  stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32'
})
child.once('spawn', () => process.send(child.pid))
child.once('error', () => process.exit(1))
child.unref()
process.stdin.resume()
setTimeout(() => process.exit(0), 20000)
`

const options = {
  ffmpegPath: process.execPath,
  format: 'webm' as const,
  fps: 10,
  quality: 30,
  scale: 1,
  speed: 1,
}

it.each([
  'attach-reject',
  'attach-timeout',
  'start-timeout',
  'target-close',
] as const)(
  'reaps the wrapper and encoder after %s, including a late session',
  async (failure) => {
    let parent: ChildProcess | undefined
    let descendantPid: number | undefined
    let ready: Promise<unknown[]> | undefined
    let expire: (() => void) | undefined
    const attachment = Promise.withResolvers<CDPSession>()
    const start = Promise.withResolvers<unknown>()
    const session = Object.assign(new EventEmitter(), {
      detach: vi.fn(async () => {}),
      send: vi.fn(async (method: string) => {
        if (method === 'Page.startScreencast') {
          return start.promise
        }
        return {}
      }),
    })
    const page = Object.assign(new EventEmitter(), {
      viewport: () => null,
      evaluate: async () => ({ width: 64, height: 64, devicePixelRatio: 1 }),
      createCDPSession: async () => {
        const message = await ready
        descendantPid = Number(message?.[0])
        if (failure === 'attach-reject') {
          throw new Error('attachment rejected')
        }
        return failure === 'start-timeout'
          ? (session as unknown as CDPSession)
          : attachment.promise
      },
    })
    try {
      const result = recordScreencast(page as unknown as Page, options, {
        clock: {
          ...systemClock,
          setTimeout(callback, milliseconds) {
            if (milliseconds === 10_000) {
              expire = callback
            }
            return systemClock.setTimeout(callback, milliseconds)
          },
        },
        spawnProcess: () => {
          parent = spawn(process.execPath, ['-e', wrapperProgram], {
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            detached: process.platform !== 'win32',
            windowsHide: true,
          })
          ready = once(parent, 'message')
          return parent
        },
      }).catch((error: unknown) => error)
      await expect.poll(() => descendantPid).toBeGreaterThan(0)
      if (failure === 'start-timeout') {
        await expect.poll(() => session.send.mock.calls.length).toBe(1)
      }
      if (failure === 'target-close') {
        page.emit('close')
      } else if (failure !== 'attach-reject') {
        expect(nodeProcess.isAlive(descendantPid as number)).toBe(true)
        expect(expire).toBeTypeOf('function')
        expire?.()
      }
      const error = await result
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(
        /attachment rejected|startup timed out|Page closed/u,
      )
      await expect
        .poll(() => nodeProcess.isAlive(parent?.pid as number))
        .toBe(false)
      await expect
        .poll(() => nodeProcess.isAlive(descendantPid as number))
        .toBe(false)
      attachment.resolve(session as unknown as CDPSession)
      start.resolve({})
      await new Promise((resolve) => setImmediate(resolve))
      if (failure !== 'attach-reject') {
        expect(session.detach).toHaveBeenCalledOnce()
      }
      expect(session.listenerCount('Page.screencastFrame')).toBe(0)
      expect(page.listenerCount('close')).toBe(0)
      expect(parent?.stdin?.destroyed).toBe(true)
      expect(parent?.stdout?.destroyed).toBe(true)
      expect(parent?.stderr?.destroyed).toBe(true)
    } finally {
      if (parent && parent.exitCode === null && parent.signalCode === null) {
        await terminateFfmpegProcessTree(parent, true)
      }
      if (descendantPid && nodeProcess.isAlive(descendantPid)) {
        try {
          process.kill(descendantPid, 'SIGKILL')
        } catch {
          // The test-owned process may exit between the check and the signal.
        }
      }
    }
  },
  15_000,
)

it('captures an early real encoder exit before CDP attachment completes', async () => {
  const attachment = Promise.withResolvers<CDPSession>()
  const session = { detach: vi.fn(async () => {}) }
  let parent: ChildProcess | undefined
  try {
    await expect(
      recordScreencast(
        {
          viewport: () => null,
          evaluate: async () => ({
            width: 64,
            height: 64,
            devicePixelRatio: 1,
          }),
          createCDPSession: () => attachment.promise,
        } as unknown as Page,
        options,
        {
          spawnProcess: () => {
            parent = spawn(
              process.execPath,
              [
                '-e',
                'console.error("early encoder failure"); process.exitCode = 7',
              ],
              {
                stdio: ['pipe', 'pipe', 'pipe'],
                detached: process.platform !== 'win32',
                windowsHide: true,
              },
            )
            return parent
          },
        },
      ),
    ).rejects.toThrow(
      'exited with code 7 during screencast startup: early encoder failure',
    )
    expect(parent?.exitCode).toBe(7)
    expect(nodeProcess.isAlive(parent?.pid as number)).toBe(false)
    attachment.resolve(session as unknown as CDPSession)
    await new Promise((resolve) => setImmediate(resolve))
    expect(session.detach).toHaveBeenCalledOnce()
  } finally {
    if (parent && parent.exitCode === null && parent.signalCode === null) {
      await terminateFfmpegProcessTree(parent, true)
    }
  }
})
