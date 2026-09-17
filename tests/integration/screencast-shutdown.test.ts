import { type ChildProcess, spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import type { CDPSession, Page } from 'puppeteer-core'
import { expect, it } from 'vitest'
import { nodeProcess } from '../../src/service/boundaries.js'
import { terminateFfmpegProcessTree } from '../../src/service/process-supervisor.js'
import {
  recordScreencast,
  type ScreencastRecorder,
} from '../../src/service/screencast-recorder.js'

// A real, self-expiring process substitutes for an encoder that never exits
// after EOF. It ignores SIGTERM on Linux, so cleanup must force termination.
const encoderProgram = `
process.on('SIGTERM', () => {})
process.stdin.resume()
process.stdout.write('preserved-partial-media')
process.send('ready')
setTimeout(() => process.exit(0), 20000)
`

it.each(['cdp-stop', 'encoder-exit'])(
  'reaps an encoder stalled at %s and preserves bytes already written',
  async (stall) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'video-shutdown-'),
    )
    const outputPath = path.join(directory, 'partial.webm')
    const output = createWriteStream(outputPath)
    const outputDone = finished(output)
    let child: ChildProcess | undefined
    let ready: Promise<unknown> | undefined
    let recorder: ScreencastRecorder | undefined
    const session = new EventEmitter()
    let stopRequested = false
    const cdp = Object.assign(session, {
      async detach() {},
      async send(method: string) {
        if (method === 'Page.startScreencast') {
          session.emit('Page.screencastFrame', {
            data: Buffer.from('frame').toString('base64'),
            metadata: { timestamp: 1 },
            sessionId: 1,
          })
        }
        if (method === 'Page.stopScreencast') {
          stopRequested = true
          if (stall === 'cdp-stop') {
            await new Promise(() => {})
          }
        }
        return {}
      },
    }) as unknown as CDPSession
    const page = {
      viewport: () => null,
      evaluate: async () => ({ width: 64, height: 64, devicePixelRatio: 1 }),
      createCDPSession: async () => cdp,
    } as unknown as Page

    try {
      recorder = await recordScreencast(
        page,
        {
          ffmpegPath: process.execPath,
          format: 'webm',
          fps: 10,
          quality: 30,
          scale: 1,
          speed: 1,
        },
        {
          spawnProcess: () => {
            child = spawn(process.execPath, ['-e', encoderProgram], {
              stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
              detached: process.platform !== 'win32',
              windowsHide: true,
            })
            ready = once(child, 'message')
            return child
          },
        },
      )
      recorder.pipe(output)
      await ready
      const pid = child?.pid
      expect(pid).toBeDefined()
      await expect
        .poll(async () => (await fs.stat(outputPath)).size)
        .toBeGreaterThan(0)

      const stopping = recorder.stop()
      await expect.poll(() => stopRequested).toBe(true)
      if (stall === 'encoder-exit') {
        await expect.poll(() => child?.stdin?.writableEnded).toBe(true)
      }
      // Matches engine cancellation after its deadline; no five-second sleep
      // is needed to test the real OS cleanup that follows the timer.
      recorder.destroy()
      await recorder.abort()
      output.end()

      await stopping
      await outputDone
      await expect.poll(() => nodeProcess.isAlive(pid as number)).toBe(false)
      expect(session.listenerCount('Page.screencastFrame')).toBe(0)
      expect(await fs.readFile(outputPath, 'utf8')).toBe(
        'preserved-partial-media',
      )
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        await terminateFfmpegProcessTree(child, true)
      }
      recorder?.destroy()
      output.destroy()
      await outputDone.catch(() => undefined)
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
  15_000,
)
