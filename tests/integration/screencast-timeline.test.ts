import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import type { CDPSession, Page } from 'puppeteer-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nodeFileSystem, systemClock } from '../../src/service/boundaries.js'
import { CaptureSession } from '../../src/service/capture-session.js'
import { readFfmpegVersion } from '../../src/service/ffmpeg.js'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import {
  buildH264TranscodeArgs,
  resolveTimestampPassthroughArgs,
} from '../../src/service/post-process.js'
import { PuppeteerCaptureEngine } from '../../src/service/puppeteer-capture-engine.js'
import {
  recordScreencast,
  type ScreencastQueueLimits,
  type ScreencastQueueStats,
  type ScreencastRecorder,
} from '../../src/service/screencast-recorder.js'
import { requireE2eFfmpeg } from '../scripts/ffmpeg-detection.js'
import {
  decodeColorTimeline,
  type SolidColor,
  solidPng,
} from '../utils/media-timeline.js'

// Real FFmpeg, real recorder, simulated screencast: frames and time are
// scripted, so the decoded video must show each color for exactly its span.

let ffmpegPath = ''
let passthrough: readonly string[] = []
let directory = ''

beforeAll(async () => {
  const detection = await requireE2eFfmpeg()
  if (!detection.resolvedPath) {
    throw new Error('FFmpeg is required for the recorder timeline tests')
  }
  ffmpegPath = detection.resolvedPath
  passthrough = resolveTimestampPassthroughArgs(
    await readFfmpegVersion(ffmpegPath),
  )
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'screencast-timeline-'))
})

afterAll(async () => {
  if (!process.env.KEEP_TIMELINE) {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

interface ScriptedFrame {
  readonly at: number
  readonly color: SolidColor
  readonly height?: number
  readonly width?: number
}

interface RecordOptions {
  readonly queueLimits?: Partial<ScreencastQueueLimits>
  readonly speed?: number
  /** Hold FFmpeg's input until stop, like an encoder starved of CPU. */
  readonly stalled?: boolean
}

// Puts a gate in front of FFmpeg's input that accepts nothing until opened.
const stallInput = (child: ChildProcess): (() => void) => {
  const input = child.stdin
  if (!input) {
    throw new Error('FFmpeg has no input')
  }
  // The recorder's encoder guards the gate; guard the pipe behind it.
  input.on('error', () => {})
  let open = false
  let waiting: (() => void) | undefined
  child.stdin = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      const forward = (): void => {
        if (input.write(chunk)) {
          callback()
        } else {
          input.once('drain', () => callback())
        }
      }
      if (open) {
        forward()
      } else {
        waiting = forward
      }
    },
    final(callback) {
      input.end(() => callback())
    },
    destroy(error, callback) {
      input.destroy()
      callback(error)
    },
  })
  return () => {
    open = true
    waiting?.()
    waiting = undefined
  }
}

/** Records scripted frames, firing the one-second hold timer as time passes. */
const recordScripted = async (
  name: string,
  frames: readonly ScriptedFrame[],
  stopAt: number,
  recorderOptions: RecordOptions = {},
): Promise<{
  output: string
  recorder: ScreencastRecorder
  /** Queue measurements just before a stalled encoder is released. */
  stalledStats: ScreencastQueueStats | undefined
}> => {
  const images = new Map<string, string>()
  const image = (frame: ScriptedFrame): string => {
    const key = `${frame.color}-${String(frame.width)}x${String(frame.height)}`
    let data = images.get(key)
    if (!data) {
      data = solidPng(
        ffmpegPath,
        frame.color,
        frame.width ?? 320,
        frame.height ?? 240,
      ).toString('base64')
      images.set(key, data)
    }
    return data
  }
  let now = 0
  let hold: (() => void) | undefined
  let sessionId = 0
  const session = Object.assign(new EventEmitter(), {
    detach: async () => {},
    send: async (method: string) => {
      if (method === 'Page.startScreencast') {
        emit(frames[0] as ScriptedFrame)
      }
      return {}
    },
  })
  const emit = (frame: ScriptedFrame): void => {
    now = frame.at * 1_000
    sessionId += 1
    session.emit('Page.screencastFrame', {
      data: image(frame),
      metadata: { timestamp: 1_000 + frame.at },
      sessionId,
    })
  }
  const page = createPage(session)
  let release: (() => void) | undefined
  const recorder = await recordScreencast(
    page,
    {
      ffmpegPath,
      format: 'webm',
      fps: 30,
      quality: 30,
      scale: 1,
      speed: recorderOptions.speed ?? 1,
    },
    {
      clock: {
        ...systemClock,
        clearInterval: () => {},
        setInterval: (callback) => {
          hold = callback
          return { unref: () => {} } as unknown as NodeJS.Timeout
        },
      },
      monotonicNow: () => now,
      ...(recorderOptions.queueLimits
        ? { queueLimits: recorderOptions.queueLimits }
        : {}),
      ...(recorderOptions.stalled
        ? {
            spawnProcess: (command: string, args: string[]) => {
              const child = spawnEncoder(command, args)
              release = stallInput(child)
              return child
            },
          }
        : {}),
    },
  )
  const output = path.join(directory, `${name}.webm`)
  const file = createWriteStream(output)
  recorder.pipe(file)
  let second = 1
  for (const frame of frames.slice(1)) {
    for (; second < frame.at; second += 1) {
      now = second * 1_000
      hold?.()
    }
    emit(frame)
  }
  for (; second <= stopAt; second += 1) {
    now = second * 1_000
    hold?.()
  }
  now = stopAt * 1_000
  const stalledStats = release ? recorder.queueStats : undefined
  release?.()
  await recorder.stop()
  await finished(file)
  expect(recorder.ffmpegResult.code).toBe(0)
  return { output, recorder, stalledStats }
}

const record = async (
  ...args: Parameters<typeof recordScripted>
): Promise<string> => (await recordScripted(...args)).output

const createPage = (session: EventEmitter): Page =>
  Object.assign(new EventEmitter(), {
    createCDPSession: async () => session as unknown as CDPSession,
    evaluate: async () => ({ devicePixelRatio: 1, height: 240, width: 320 }),
    viewport: () => null,
  }) as unknown as Page

const spawnEncoder = (command: string, args: string[]): ChildProcess =>
  spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

describe('recorded frame timeline', () => {
  it('shows each frame for its span across a frame size change', async () => {
    const output = await record(
      'resize',
      [
        { at: 0, color: 'red' },
        // Priming and window changes alter the frame size mid-recording.
        { at: 3, color: 'green', width: 322 },
        { at: 4, color: 'blue' },
      ],
      6,
    )
    const timeline = decodeColorTimeline(ffmpegPath, output, 30, passthrough)
    expect(timeline.spans).toEqual([
      { color: 'red', start: 0, end: 3 },
      { color: 'green', start: 3, end: 4 },
      { color: 'blue', start: 4, end: 6 },
    ])
    // Unchanged images are held, not re-encoded at every grid position.
    expect(timeline.frames).toBeLessThan(20)
    // Widely playable 4:2:0 VP9, not planar RGB.
    expect(timeline.codecLine).toMatch(/vp9 \(Profile 0\).*yuv420p/u)
  })

  it('keeps timing across a quiet stretch longer than a Matroska cluster', async () => {
    const output = await record(
      'long-gap',
      [
        { at: 0, color: 'red' },
        { at: 35, color: 'green' },
      ],
      36,
    )
    expect(
      decodeColorTimeline(ffmpegPath, output, 30, passthrough).spans,
    ).toEqual([
      { color: 'red', start: 0, end: 35 },
      { color: 'green', start: 35, end: 36 },
    ])
  })

  it('plays back at the configured speed', async () => {
    const output = await record(
      'speed',
      [
        { at: 0, color: 'red' },
        { at: 2, color: 'green' },
      ],
      4,
      { speed: 2 },
    )
    expect(
      decodeColorTimeline(ffmpegPath, output, 60, passthrough).spans,
    ).toEqual([
      { color: 'red', start: 0, end: 1 },
      { color: 'green', start: 1, end: 2 },
    ])
  })

  it('keeps every span and the exact duration through the H.264 transcode', async () => {
    // Sparse, irregular frames like a real UI test: a burst, then a long hold.
    const source = await record(
      'transcode-source',
      [
        { at: 0, color: 'red' },
        { at: 0.1, color: 'green' },
        { at: 0.2, color: 'red' },
        { at: 2, color: 'green' },
        { at: 3, color: 'blue' },
      ],
      5,
    )
    const output = path.join(directory, 'transcoded.mp4')
    const result = spawnSync(
      ffmpegPath,
      buildH264TranscodeArgs(source, output, undefined, passthrough),
    )
    expect(result.status, result.stderr.toString()).toBe(0)
    expect(
      decodeColorTimeline(ffmpegPath, output, 30, passthrough).spans,
    ).toEqual([
      { color: 'red', start: 0, end: 0.1 },
      { color: 'green', start: 0.1, end: 0.2 },
      { color: 'red', start: 0.2, end: 2 },
      { color: 'green', start: 2, end: 3 },
      { color: 'blue', start: 3, end: 5 },
    ])
    // Players size the timeline from the container, not the last frame.
    const probe = spawnSync(ffmpegPath, ['-hide_banner', '-i', output])
    const duration = /Duration: (\d+):(\d+):([\d.]+)/u.exec(
      probe.stderr.toString(),
    )
    expect(Math.abs(Number(duration?.[3]) - 5)).toBeLessThanOrEqual(1 / 30)
  })
})

describe('recorded frame timeline under a stalled encoder', () => {
  it('holds an unchanged page for a minute with a bounded queue', async () => {
    const { output, stalledStats } = await recordScripted(
      'stalled-static',
      [{ at: 0, color: 'red' }],
      61,
      { queueLimits: { maxPendingBlocks: 2 }, stalled: true },
    )
    // A minute of holds while FFmpeg accepted nothing: one block waited, and
    // the diagnostics still report the minute it waited for.
    expect(stalledStats).toMatchObject({
      highWaterBlocks: 1,
      highWaterLagSeconds: 60,
      pendingBlocks: 1,
    })
    const timeline = decodeColorTimeline(ffmpegPath, output, 30, passthrough)
    // The held frame spans the gap, across Matroska clusters, to the end.
    expect(timeline.spans).toEqual([{ color: 'red', start: 0, end: 61 }])
    expect(timeline.frames).toBeLessThan(8)
  })

  it('ends an overloaded recording where capture stopped, with every earlier span intact', async () => {
    const { output, recorder, stalledStats } = await recordScripted(
      'stalled-overload',
      [
        { at: 0, color: 'red' },
        { at: 2, color: 'green' },
        { at: 4, color: 'blue' },
        { at: 6, color: 'red' },
      ],
      8,
      { queueLimits: { maxPendingBlocks: 2 }, stalled: true },
    )
    expect(recorder.incompleteReason).toBe(
      'The encoder fell behind the screencast (2 frames waiting for the encoder reached the limit of 2); capture stopped after 4.0s to bound memory.',
    )
    expect(stalledStats?.highWaterBlocks).toBe(2)
    // Once released, the encoder writes every accepted frame at its own time,
    // and the recording ends where the rejected blue frame would have begun.
    expect(
      decodeColorTimeline(ffmpegPath, output, 30, passthrough).spans,
    ).toEqual([
      { color: 'red', start: 0, end: 2 },
      { color: 'green', start: 2, end: 4 },
    ])
  })
})

describe('recorded frame timeline when the encoder exits early', () => {
  it('keeps a successful early exit as unclean media rather than a healthy recording', async () => {
    const data = solidPng(ffmpegPath, 'red', 320, 240).toString('base64')
    let now = 0
    let sessionId = 0
    const session = Object.assign(new EventEmitter(), {
      detach: async () => {},
      send: async (method: string) => {
        if (method === 'Page.startScreencast') {
          emit()
        }
        return {}
      },
    })
    const emit = (): void => {
      sessionId += 1
      session.emit('Page.screencastFrame', {
        data,
        metadata: { timestamp: 1_000 + now / 1_000 },
        sessionId,
      })
    }
    const exited = Promise.withResolvers<void>()
    const recorder = await recordScreencast(
      createPage(session),
      { ffmpegPath, format: 'webm', fps: 30, quality: 30, scale: 1, speed: 1 },
      {
        monotonicNow: () => now,
        // As a configured FFmpeg wrapper limiting output length would: the
        // encoder finishes successfully while the test is still running.
        // Minimal probing lets it start encoding before input ends.
        spawnProcess: (command, args) => {
          const child = spawnEncoder(command, [
            ...['-analyzeduration', '0', '-probesize', '32'],
            ...args.slice(0, -1),
            ...['-t', '0.1'],
            ...args.slice(-1),
          ])
          child.once('close', () => exited.resolve())
          return child
        },
      },
    )
    const output = path.join(directory, 'early-exit.webm')
    const file = createWriteStream(output)
    const writeStreamDone = finished(file)
    recorder.pipe(file)
    for (let frame = 1; frame <= 30; frame += 1) {
      now = frame * 100
      emit()
    }
    await exited.promise
    await writeStreamDone

    const captureSession = new CaptureSession()
    captureSession.beginRecording('early-exit')
    captureSession.attachCapture({
      recorder,
      segment: {
        onRecorderError: () => {},
        onWriteStreamError: () => {},
        outputFormat: 'webm',
        outputPath: output,
        recordingFormat: 'webm',
        recordingPath: output,
        transcode: true,
        transcodeOptions: { deleteOriginal: true },
        writeStream: file,
        writeStreamDone,
        writeStreamErrored: false,
      },
      windowHandle: undefined,
    })
    const engine = new PuppeteerCaptureEngine({
      capture: resolveServiceConfiguration({}).options.capture,
      clock: systemClock,
      connectPuppeteer: async () => {
        throw new Error('Capture is attached directly')
      },
      fileSystem: nodeFileSystem,
      getSessionToken: () => 'session',
      log: () => {},
      onConnectionFailure: () => {},
      onProtocolChanged: () => {},
      session: captureSession,
      startScreencast: async () => {
        throw new Error('Capture is attached directly')
      },
      uuid: () => 'uuid',
    })

    // Exit code 0, three seconds of frames captured, but FFmpeg never saw the
    // end of its input: the recording is incomplete, not transcoded.
    const stopped = await engine.stopCapture()
    expect(recorder.frameCount).toBe(31)
    expect(recorder.ffmpegResult.code).toBe(0)
    expect(stopped).toMatchObject({
      incompleteReason:
        'FFmpeg exited with code 0 before the recording was stopped.',
      segment: { outputPath: output, transcode: false },
      streamOk: false,
    })
    // What FFmpeg wrote is kept and still decodes, for diagnosis.
    const timeline = decodeColorTimeline(ffmpegPath, output, 30, passthrough)
    expect(timeline.spans).toHaveLength(1)
    expect(timeline.spans[0]).toMatchObject({ color: 'red', start: 0 })
    expect(timeline.spans[0]?.end).toBeLessThan(0.5)
  })
})
