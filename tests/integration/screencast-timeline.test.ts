import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import type { CDPSession, Page } from 'puppeteer-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type ClockBoundary,
  nodeFileSystem,
  systemClock,
} from '../../src/service/boundaries.js'
import { CaptureSession } from '../../src/service/capture-session.js'
import {
  probeDirectMp4Support,
  readFfmpegVersion,
} from '../../src/service/ffmpeg.js'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import {
  buildH264TranscodeArgs,
  resolveTimestampPassthroughArgs,
} from '../../src/service/post-process.js'
import {
  type CaptureStopResult,
  PuppeteerCaptureEngine,
} from '../../src/service/puppeteer-capture-engine.js'
import {
  recordScreencast,
  type ScreencastQueueLimits,
  type ScreencastQueueStats,
  type ScreencastRecorder,
} from '../../src/service/screencast-recorder.js'
import { SpoolBudget } from '../../src/service/spool-budget.js'
import {
  encodeSpool,
  type SpoolEncodeRunner,
} from '../../src/service/spool-encode.js'
import type { PromotionPlan } from '../../src/service/spool-promotion.js'
import type { OutputFormat } from '../../src/types.js'
import { requireE2eFfmpeg } from '../scripts/ffmpeg-detection.js'
import {
  parseMatroskaStream,
  readMatroskaIndex,
} from '../utils/matroska-blocks.js'
import {
  type ColorSpan,
  type DecodedTimeline,
  decodeColorAt,
  decodeColorTimeline,
  readContainerDuration,
  type SolidColor,
  solidPng,
} from '../utils/media-timeline.js'

// Real FFmpeg, real recorder, simulated screencast: frames and time are
// scripted, so the decoded video must show each color for exactly its span.

const detection = await requireE2eFfmpeg()
if (!detection.resolvedPath) {
  throw new Error('FFmpeg is required for the recorder timeline tests')
}
const ffmpegPath = detection.resolvedPath
const passthrough = resolveTimestampPassthroughArgs(
  await readFfmpegVersion(ffmpegPath),
)
// Direct MP4 recording needs `-movflags hybrid_fragmented` (FFmpeg 7.1+).
const directMp4 = await probeDirectMp4Support(ffmpegPath)
let directory = ''

beforeAll(async () => {
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
  readonly format?: OutputFormat
  /** Record as before FFmpeg wrote its own file: its stdout, piped here. */
  readonly pipeTo?: string
  readonly queueLimits?: Partial<ScreencastQueueLimits>
  readonly speed?: number
  /** Spool the stream, then encode the spool once stopped. */
  readonly spool?: boolean
  /** Hold FFmpeg's input until stop, like an encoder starved of CPU. */
  readonly stalled?: boolean
  /** Keep a copy of every byte the live encoder is given. */
  readonly tapInput?: Buffer[]
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

const images = new Map<string, string>()
const image = (frame: Omit<ScriptedFrame, 'at'>): string => {
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

/** A scripted screencast on a fake page, with a controllable clock. */
const createFrameSource = (first: ScriptedFrame) => {
  let now = 0
  let sessionId = 0
  const session = Object.assign(new EventEmitter(), {
    detach: async () => {},
    send: async (method: string) => {
      if (method === 'Page.startScreencast') {
        emit(first)
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
  return {
    emit,
    monotonicNow: () => now,
    page: createPage(session),
    setNow: (milliseconds: number) => {
      now = milliseconds
    },
  }
}

/** The output path, reserved by an empty file as the service reserves it. */
const reserveOutput = async (
  name: string,
  format: OutputFormat,
): Promise<string> => {
  const output = path.join(directory, `${name}.${format}`)
  await fs.writeFile(output, '')
  return output
}

/** Copies every write to the encoder's input into `chunks`. */
const tapInput = (child: ChildProcess, chunks: Buffer[]): void => {
  const input = child.stdin
  if (!input) {
    throw new Error('FFmpeg has no input')
  }
  const write = input.write.bind(input)
  input.write = ((chunk: Buffer) => {
    chunks.push(Buffer.from(chunk))
    return write(chunk)
  }) as typeof input.write
}

/** Runs FFmpeg as the service's runtime would, reporting how it exited. */
const runFfmpegProcess: SpoolEncodeRunner = async ({ args, ffmpegPath }) => {
  const child = spawn(ffmpegPath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  const stderr: Buffer[] = []
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const [code, signal] = (await once(child, 'close')) as [
    number | null,
    NodeJS.Signals | null,
  ]
  return {
    code,
    diagnostic: Buffer.concat(stderr).toString().trim(),
    signal,
  }
}

const spoolSettings = (format: OutputFormat, speed: number) => ({
  ffmpegPath,
  format,
  fps: 30,
  quality: 30,
  scale: 1,
  speed,
})

/** Encodes a stopped or abandoned spool into the reserved output. */
const encodeSpooled = async (
  recorder: ScreencastRecorder,
  outputPath: string,
): Promise<void> => {
  const { output } = recorder
  if (output.kind !== 'spool') {
    throw new Error('The recording was not spooled')
  }
  const encoded = await encodeSpool(
    { ffmpegPath, outputPath, spool: output.spool },
    runFfmpegProcess,
  )
  expect(encoded).toEqual({ ok: true })
}

/**
 * Emits the frames after the first at their times, firing the one-second hold
 * timer as each second passes, and leaves the clock at `until`.
 */
const playScripted = (
  source: ReturnType<typeof createFrameSource>,
  hold: () => void,
  frames: readonly ScriptedFrame[],
  until: number,
): void => {
  let second = 1
  for (const frame of frames.slice(1)) {
    for (; second < frame.at; second += 1) {
      source.setNow(second * 1_000)
      hold()
    }
    source.emit(frame)
  }
  for (; second <= until; second += 1) {
    source.setNow(second * 1_000)
    hold()
  }
  source.setNow(until * 1_000)
}

/** A clock whose hold timer the script fires by hand. */
const createHoldClock = (): {
  clock: ClockBoundary
  hold: () => void
} => {
  let hold: (() => void) | undefined
  return {
    clock: {
      ...systemClock,
      clearInterval: () => {},
      setInterval: (callback) => {
        hold = callback
        return { unref: () => {} } as unknown as NodeJS.Timeout
      },
    },
    hold: () => hold?.(),
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
  const format = recorderOptions.format ?? 'webm'
  const output = await reserveOutput(name, format)
  const spoolPath = recorderOptions.spool
    ? path.join(directory, `${name}.spool.mkv`)
    : undefined
  const holdClock = createHoldClock()
  const source = createFrameSource(frames[0] as ScriptedFrame)
  let release: (() => void) | undefined
  let piped: Promise<void> | undefined
  const spawnProcess = (command: string, args: string[]): ChildProcess => {
    const { pipeTo } = recorderOptions
    if (recorderOptions.tapInput) {
      const child = spawnEncoder(command, args)
      tapInput(child, recorderOptions.tapInput)
      return child
    }
    if (pipeTo) {
      const child = spawn(command, [...args.slice(0, -1), 'pipe:1'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const file = createWriteStream(pipeTo)
      child.stdout?.pipe(file)
      piped = finished(file)
      return child
    }
    const child = spawnEncoder(command, args)
    release = stallInput(child)
    return child
  }
  const settings = spoolSettings(format, recorderOptions.speed ?? 1)
  const recorder = await recordScreencast(
    source.page,
    spoolPath
      ? { ...settings, spoolPath }
      : { ...settings, outputPath: output },
    {
      clock: holdClock.clock,
      monotonicNow: source.monotonicNow,
      ...(recorderOptions.queueLimits
        ? { queueLimits: recorderOptions.queueLimits }
        : {}),
      // Otherwise FFmpeg is spawned exactly as the service spawns it.
      ...(recorderOptions.stalled ||
      recorderOptions.pipeTo ||
      recorderOptions.tapInput
        ? { spawnProcess }
        : {}),
    },
  )
  playScripted(source, holdClock.hold, frames, stopAt)
  const stalledStats = release ? recorder.queueStats : undefined
  release?.()
  await recorder.stop()
  await piped
  if (spoolPath) {
    expect(recorder.incompleteReason).toBeUndefined()
    await encodeSpooled(recorder, output)
  } else {
    expect(recorder.ffmpegResult.code).toBe(0)
  }
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

// As the service spawns it: FFmpeg writes the output file, not its stdout.
const spawnEncoder = (command: string, args: string[]): ChildProcess =>
  spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })

/**
 * A player sizes its timeline from the container. A finished recording's
 * duration is where its last frame ends, to within one step of the grid.
 */
const expectFiniteDuration = (
  output: string,
  timeline: DecodedTimeline,
  fps: number,
): void => {
  const duration = readContainerDuration(ffmpegPath, output)
  expect(duration, `${output} reports Duration: N/A`).toBeDefined()
  const lastEnd = timeline.spans.at(-1)?.end ?? 0
  expect(Math.abs((duration ?? 0) - lastEnd)).toBeLessThanOrEqual(
    1 / fps + 0.001,
  )
}

/** The seek index FFmpeg writes once it can seek back into its output. */
const expectSeekIndex = async (output: string): Promise<void> => {
  const index = readMatroskaIndex(await fs.readFile(output))
  expect(index.hasCues, `${output} has no Cues element`).toBe(true)
  expect(index.cueTimesMs.length).toBeGreaterThan(0)
  expect(index.durationMs).toBeGreaterThan(0)
}

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
    expectFiniteDuration(output, timeline, 30)
    await expectSeekIndex(output)
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
    const timeline = decodeColorTimeline(ffmpegPath, output, 30, passthrough)
    expect(timeline.spans).toEqual([
      { color: 'red', start: 0, end: 35 },
      { color: 'green', start: 35, end: 36 },
    ])
    expectFiniteDuration(output, timeline, 30)
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
    const timeline = decodeColorTimeline(ffmpegPath, output, 60, passthrough)
    expect(timeline.spans).toEqual([
      { color: 'red', start: 0, end: 1 },
      { color: 'green', start: 1, end: 2 },
    ])
    // The container duration is in playback time too.
    expectFiniteDuration(output, timeline, 60)
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
    expect(
      Math.abs((readContainerDuration(ffmpegPath, output) ?? 0) - 5),
    ).toBeLessThanOrEqual(1 / 30)
  })
})

describe('recorded WebM duration and seek index', () => {
  it('sizes and seeks to the end of a page held still for 39 seconds', async () => {
    const output = await record(
      'quiet-tail',
      [
        { at: 0, color: 'red' },
        { at: 1, color: 'green' },
      ],
      40,
    )
    const timeline = decodeColorTimeline(ffmpegPath, output, 30, passthrough)
    expect(timeline.spans).toEqual([
      { color: 'red', start: 0, end: 1 },
      { color: 'green', start: 1, end: 40 },
    ])
    expectFiniteDuration(output, timeline, 30)
    await expectSeekIndex(output)
    const index = readMatroskaIndex(await fs.readFile(output))
    expect(Math.abs((index.durationMs ?? 0) - 40_000)).toBeLessThanOrEqual(34)
    // Seeking as a player does, into the middle and the last second of the
    // long hold, decodes the held frame.
    expect(decodeColorAt(ffmpegPath, output, 0)).toBe('red')
    expect(decodeColorAt(ffmpegPath, output, 20)).toBe('green')
    expect(decodeColorAt(ffmpegPath, output, 39.5)).toBe('green')
  })

  it('owes its index to a seekable output: the same recording through a pipe has none', async () => {
    const frames: ScriptedFrame[] = [
      { at: 0, color: 'red' },
      { at: 2, color: 'blue' },
    ]
    const output = await record('pipe-control', frames, 3)
    // The service before this change: identical arguments, but FFmpeg wrote
    // to its standard output and Node copied that into the file.
    const pipedPath = path.join(directory, 'pipe-control-piped.webm')
    await record('pipe-control-source', frames, 3, { pipeTo: pipedPath })

    expect(
      decodeColorTimeline(ffmpegPath, pipedPath, 30, passthrough).spans,
    ).toEqual(decodeColorTimeline(ffmpegPath, output, 30, passthrough).spans)
    expect(readMatroskaIndex(await fs.readFile(pipedPath))).toMatchObject({
      hasCues: false,
    })
    expect(readContainerDuration(ffmpegPath, pipedPath)).toBeUndefined()
    await expectSeekIndex(output)
    expect(readContainerDuration(ffmpegPath, output)).toBeCloseTo(3, 1)
  })
})

interface SpanCase {
  readonly name: string
  readonly frames: readonly ScriptedFrame[]
  readonly stopAt: number
  /** Playback frames per second of the decoded video. */
  readonly fps?: number
  readonly speed?: number
}

const SPAN_CASES: readonly SpanCase[] = [
  {
    name: 'sparse',
    frames: [
      { at: 0, color: 'red' },
      { at: 2, color: 'blue' },
    ],
    stopAt: 3,
  },
  {
    name: 'burst',
    frames: [
      { at: 0, color: 'red' },
      { at: 0.1, color: 'green' },
      { at: 0.2, color: 'red' },
      { at: 2, color: 'green' },
      { at: 3, color: 'blue' },
    ],
    stopAt: 5,
  },
  {
    name: 'resize',
    frames: [
      { at: 0, color: 'red' },
      { at: 3, color: 'green', width: 322 },
      { at: 4, color: 'blue' },
    ],
    stopAt: 6,
  },
  {
    name: 'long-gap',
    frames: [
      { at: 0, color: 'red' },
      { at: 35, color: 'green' },
    ],
    stopAt: 36,
  },
  {
    name: 'speed',
    frames: [
      { at: 0, color: 'red' },
      { at: 2, color: 'green' },
    ],
    stopAt: 4,
    fps: 60,
    speed: 2,
  },
  // End markers: the final frame held to stop on two blocks one step apart.
  {
    name: 'held-end',
    frames: [
      { at: 0, color: 'red' },
      { at: 2, color: 'green' },
    ],
    stopAt: 5,
  },
  // End markers: a final frame first shown at the last position before stop
  // is extended by one step rather than left alone.
  {
    name: 'lone-end',
    frames: [
      { at: 0, color: 'red' },
      { at: 2.95, color: 'green' },
    ],
    stopAt: 3,
  },
]

describe('spooled recordings', () => {
  it.each(SPAN_CASES)(
    'encode to the live timeline: $name',
    async ({ name, frames, stopAt, fps = 30, speed = 1 }) => {
      const liveInput: Buffer[] = []
      const live = await recordScripted(`${name}-live`, frames, stopAt, {
        speed,
        tapInput: liveInput,
      })
      const spooled = await recordScripted(`${name}-spooled`, frames, stopAt, {
        speed,
        spool: true,
      })
      // The spool is the stream the live encoder was given, holds included.
      const spoolPath = path.join(directory, `${name}-spooled.spool.mkv`)
      expect(
        (await fs.readFile(spoolPath)).equals(Buffer.concat(liveInput)),
      ).toBe(true)

      const liveTimeline = decodeColorTimeline(
        ffmpegPath,
        live.output,
        fps,
        passthrough,
      )
      const spooledTimeline = decodeColorTimeline(
        ffmpegPath,
        spooled.output,
        fps,
        passthrough,
      )
      expect(spooledTimeline.spans).toEqual(liveTimeline.spans)
      expect(spooledTimeline.timestamps).toEqual(liveTimeline.timestamps)
      expect(readContainerDuration(ffmpegPath, spooled.output)).toBe(
        readContainerDuration(ffmpegPath, live.output),
      )
      // Finished like a live segment: sized and seekable.
      expectFiniteDuration(spooled.output, spooledTimeline, fps)
      await expectSeekIndex(spooled.output)
    },
  )
})

/**
 * Spools scripted frames and then stops as a killed worker does: no stop, so
 * no end markers, once everything given to the file has reached it.
 */
const spoolAndKill = async (
  name: string,
  frames: readonly ScriptedFrame[],
  killAt: number,
): Promise<{ recorder: ScreencastRecorder; spoolPath: string }> => {
  const spoolPath = path.join(directory, `${name}.spool.mkv`)
  const holdClock = createHoldClock()
  const source = createFrameSource(frames[0] as ScriptedFrame)
  const recorder = await recordScreencast(
    source.page,
    { ...spoolSettings('webm', 1), spoolPath },
    { clock: holdClock.clock, monotonicNow: source.monotonicNow },
  )
  playScripted(source, holdClock.hold, frames, killAt)
  await waitFor(
    () => recorder.queueStats.pendingBlocks === 0,
    'the spool to take every block',
  )
  // Let the file system take what the stream buffered, then die.
  await new Promise((resolve) => setTimeout(resolve, 200))
  await recorder.abort()
  expect(recorder.incompleteReason).toBeUndefined()
  return { recorder, spoolPath }
}

describe('a spool left by a killed worker', () => {
  it('shows the first frame, held up to the last hold, when nothing changed', async () => {
    const { recorder } = await spoolAndKill(
      'killed-first-frame',
      [{ at: 0, color: 'red' }],
      5,
    )
    const output = await reserveOutput('killed-first-frame', 'webm')
    await encodeSpooled(recorder, output)

    const spans = decodeColorTimeline(ffmpegPath, output, 30, passthrough).spans
    // Holds trail real time by half a second: the last, at 5 s, marks 4.5 s
    // and the block before it starts at 3.5 s.
    expect(spans).toEqual([{ color: 'red', start: 0, end: 3.533 }])
  })

  it('keeps the newest image after a hold when a change is followed by a quiet period', async () => {
    const { recorder } = await spoolAndKill(
      'killed-quiet-tail',
      [
        { at: 0, color: 'red' },
        { at: 1, color: 'green' },
        { at: 2, color: 'blue' },
      ],
      8,
    )
    const output = await reserveOutput('killed-quiet-tail', 'webm')
    await encodeSpooled(recorder, output)

    const spans = decodeColorTimeline(ffmpegPath, output, 30, passthrough).spans
    expect(spans.slice(0, 2)).toEqual([
      { color: 'red', start: 0, end: 1 },
      { color: 'green', start: 1, end: 2 },
    ])
    // Blue is on disk, held until the last hold before the kill.
    expect(spans[2]).toEqual({ color: 'blue', start: 2, end: 6.533 })
    expect(spans).toHaveLength(3)
  })

  it('encodes a spool cut off mid-block up to its last complete frame', async () => {
    const colors: SolidColor[] = ['red', 'green', 'blue']
    const frames = Array.from({ length: 8 }, (_unused, second) => ({
      at: second,
      color: colors[second % 3] as SolidColor,
    }))
    const { recorder, spoolPath } = await spoolAndKill(
      'killed-truncated',
      frames,
      8,
    )
    // The kill landed while the sixth image was being written.
    const bytes = await fs.readFile(spoolPath)
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    let offset = -1
    for (let image = 0; image < 6; image += 1) {
      offset = bytes.indexOf(signature, offset + 1)
    }
    expect(offset).toBeGreaterThan(0)
    await fs.writeFile(spoolPath, bytes.subarray(0, offset + 20))
    const output = await reserveOutput('killed-truncated', 'webm')
    await encodeSpooled(recorder, output)

    // Every complete block before the cut, the last one lasting a step.
    const blocks = parseMatroskaStream(bytes.subarray(0, offset + 20)).frames
    const spans = decodeColorTimeline(ffmpegPath, output, 30, passthrough).spans
    const lastStart = (blocks.at(-1)?.timestampMs ?? 0) / 1_000
    expect(spans.slice(0, -1)).toEqual(
      Array.from({ length: spans.length - 1 }, (_unused, second) => ({
        color: colors[second % 3],
        start: second,
        end: second + 1,
      })),
    )
    expect(spans.at(-1)).toMatchObject({
      color: colors[(spans.length - 1) % 3],
      start: spans.length - 1,
      end: Number((lastStart + 1 / 30).toFixed(3)),
    })
    expect(spans.length).toBeGreaterThanOrEqual(4)
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
    expectFiniteDuration(output, timeline, 30)
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

/** Stops an attached recorder through the real engine, as the service does. */
const stopThroughEngine = async (
  recorder: ScreencastRecorder,
  output: string,
  format: OutputFormat = 'webm',
): Promise<CaptureStopResult> => {
  const captureSession = new CaptureSession()
  captureSession.beginRecording('encoder-failure')
  captureSession.attachCapture({
    recorder,
    segment: {
      outputFormat: format,
      outputPath: output,
      recordingFormat: format,
      recordingPath: output,
      transcode: true,
      transcodeOptions: { deleteOriginal: true },
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
  return engine.stopCapture()
}

const waitFor = async (
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * Starts a recording whose encoder is expected to fail on its output, feeds it
 * frames until it exits, and returns why the service says it failed: the
 * startup error, or the incomplete reason a stop through the engine reports.
 * FFmpeg opens and writes its output only once it has probed some input, so
 * which of the two it is depends on timing, and both must name the cause.
 */
const failingRecordingReason = async (outputPath: string): Promise<string> => {
  const source = createFrameSource({ at: 0, color: 'red' })
  let recorder: ScreencastRecorder
  try {
    recorder = await recordScreencast(
      source.page,
      {
        ffmpegPath,
        format: 'webm',
        fps: 30,
        outputPath,
        quality: 30,
        scale: 1,
        speed: 1,
      },
      { monotonicNow: source.monotonicNow, spawnProcess: spawnEncoder },
    )
  } catch (error) {
    return (error as Error).message
  }
  let at = 0
  await waitFor(async () => {
    at += 0.1
    source.emit({ at, color: at % 0.2 < 0.1 ? 'red' : 'green' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    return recorder.ffmpegResult.code !== null
  }, 'the encoder to fail')
  const stopped = await stopThroughEngine(recorder, outputPath)
  expect(stopped).toMatchObject({
    segment: { transcode: false },
    streamOk: false,
  })
  return stopped.incompleteReason ?? ''
}

describe('recorded frame timeline when the encoder fails on its output', () => {
  it('reports an output file FFmpeg cannot open, and leaves no file behind', async () => {
    // The reserved path's directory is gone, as when the output directory is
    // removed while a test runs.
    const missingDirectory = path.join(directory, 'removed-output-directory')
    const outputPath = path.join(missingDirectory, 'segment.webm')

    const reason = await failingRecordingReason(outputPath)

    expect(reason).toMatch(/^FFmpeg exited with code -?\d+ /u)
    // FFmpeg's own explanation, as FFmpeg 6 and later or 4.4 word it.
    expect(reason).toMatch(/Error opening output|No such file or directory/u)
    await expect(fs.stat(missingDirectory)).rejects.toThrow()
  })

  it.runIf(process.platform === 'win32' || process.platform === 'linux')(
    'reports a write to the output failing mid-recording',
    async () => {
      // A full disk, made real: Linux's /dev/full refuses every write; on
      // Windows a named pipe whose reader hangs up after the first bytes.
      let outputPath = '/dev/full'
      let server: net.Server | undefined
      if (process.platform === 'win32') {
        outputPath = `\\\\.\\pipe\\wdio-video-write-failure-${process.pid.toString()}`
        server = net.createServer((socket) => {
          socket.on('error', () => {})
          socket.once('data', () => socket.destroy())
        })
        const listening = once(server, 'listening')
        server.listen(outputPath)
        await listening
      }
      try {
        const reason = await failingRecordingReason(outputPath)

        expect(reason).toMatch(/^FFmpeg exited with code -?\d+ /u)
        // FFmpeg's own explanation, not a generic stream error.
        expect(reason).toMatch(
          /Error (muxing|writing|submitting)|write_frame|No space left|Invalid argument|Broken pipe/u,
        )
      } finally {
        server?.close()
      }
    },
  )
})

/** Waits until FFmpeg has stopped growing its output, so all it was given is written. */
const waitForWrittenOutput = async (output: string): Promise<void> => {
  let previous = -1
  let stableSince = Date.now()
  await waitFor(async () => {
    const { size } = await fs.stat(output)
    if (size !== previous) {
      previous = size
      stableSince = Date.now()
    }
    // Unchanged for a second, empty or not: an encoder that buffers its
    // output would leave nothing, and the decode below then fails.
    return Date.now() - stableSince >= 1_000
  }, `${output} to stop growing`)
}

const CYCLE: readonly SolidColor[] = ['red', 'green', 'blue']
const KILL_AT_SECONDS = 12

/**
 * Feeds the encoder 30 frames a second for twelve seconds, a new color each
 * second, waits until its output stops growing, then kills it with SIGKILL as
 * a crashed worker's encoder would be, before any stop. A page in motion keeps
 * frames coming: FFmpeg's PNG decoder holds up to 16 frames across its
 * threads, so a sparse feed would measure that latency rather than the muxer.
 */
const recordAndKill = async (
  format: OutputFormat,
): Promise<{ output: string; recorder: ScreencastRecorder }> => {
  const output = await reserveOutput(`killed-${format}`, format)
  const source = createFrameSource({ at: 0, color: 'red' })
  let child: ChildProcess | undefined
  const recorder = await recordScreencast(
    source.page,
    {
      ffmpegPath,
      format,
      fps: 30,
      outputPath: output,
      quality: 30,
      scale: 1,
      speed: 1,
    },
    {
      monotonicNow: source.monotonicNow,
      spawnProcess: (command, args) => {
        child = spawnEncoder(command, args)
        return child
      },
    },
  )
  for (let frame = 1; frame <= KILL_AT_SECONDS * 30; frame += 1) {
    const at = frame / 30
    source.emit({ at, color: CYCLE[Math.floor(at) % 3] as SolidColor })
  }
  if (!child) {
    throw new Error('The encoder was not spawned')
  }
  const closed = once(child, 'close')
  try {
    await waitForWrittenOutput(output)
  } finally {
    child.kill('SIGKILL')
    await closed
    await recorder.abort()
  }
  return { output, recorder }
}

const expectedKilledSpans = (decoded: number): ColorSpan[] =>
  Array.from({ length: decoded }, (_unused, second) => ({
    color: CYCLE[second % 3] as SolidColor,
    start: second,
    end: second + 1,
  }))

/**
 * What a killed encoder leaves must decode, every span intact, to within two
 * seconds of the last frame it had been given. Clusters close each second and
 * every packet is flushed as it is written, so the open cluster, at most a
 * second, plus the decoder's frames in flight (16 frames, about half a second
 * here) can be lost; two seconds leaves a little margin. With FFmpeg's default
 * cluster and flush settings the audit lost about 8 of 12 seconds, which this
 * bound fails.
 */
const expectKilledTail = (output: string, recorder: ScreencastRecorder) => {
  expect(recorder.incompleteReason).toMatch(
    /^FFmpeg (was terminated by SIGKILL|exited with code -?\d+) before the recording was stopped/u,
  )
  const spans = decodeColorTimeline(ffmpegPath, output, 30, passthrough).spans
  const last = spans.at(-1)
  expect(last?.start).toBeGreaterThanOrEqual(KILL_AT_SECONDS - 2)
  // Every span before the last is exact; the last lasts one grid step.
  expect(spans.slice(0, -1)).toEqual(expectedKilledSpans(spans.length - 1))
  const expectedLast = expectedKilledSpans(spans.length).at(-1)
  expect(last).toMatchObject({
    color: expectedLast?.color,
    start: expectedLast?.start,
  })
}

describe('recorded frame timeline when the encoder is killed', () => {
  it('leaves a WebM that decodes to within two seconds of what it was given', async () => {
    const { output, recorder } = await recordAndKill('webm')
    expectKilledTail(output, recorder)
  }, 30_000)
})

describe.runIf(directMp4)(
  'direct MP4 recording (needs an FFmpeg that accepts -movflags hybrid_fragmented, 7.1 or later)',
  () => {
    it('sizes and seeks to the end of a page held still', async () => {
      const output = await record(
        'direct-quiet-tail',
        [
          { at: 0, color: 'red' },
          { at: 1, color: 'green' },
        ],
        20,
        { format: 'mp4' },
      )
      const timeline = decodeColorTimeline(ffmpegPath, output, 30, passthrough)
      expect(timeline.spans).toEqual([
        { color: 'red', start: 0, end: 1 },
        { color: 'green', start: 1, end: 20 },
      ])
      expectFiniteDuration(output, timeline, 30)
      // A finished hybrid MP4 carries a regular index for players.
      expect(readMp4TopLevelBoxes(await fs.readFile(output))).toContain('moov')
      expect(decodeColorAt(ffmpegPath, output, 19.5)).toBe('green')
    })

    it('leaves a killed encoder an MP4 that decodes to within two seconds', async () => {
      const { output, recorder } = await recordAndKill('mp4')
      expectKilledTail(output, recorder)
    }, 30_000)
  },
)

/** The four-character types of an MP4's top-level boxes, in order. */
const readMp4TopLevelBoxes = (bytes: Buffer): string[] => {
  const boxes: string[] = []
  let offset = 0
  while (offset + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(offset)
    boxes.push(bytes.toString('latin1', offset + 4, offset + 8))
    if (size === 1 && offset + 16 <= bytes.length) {
      size = Number(bytes.readBigUInt64BE(offset + 8))
    }
    if (size < 8) {
      break
    }
    offset += size
  }
  return boxes
}

describe('recorded frame timeline when the encoder exits early', () => {
  it('keeps a successful early exit as unclean media rather than a healthy recording', async () => {
    const output = await reserveOutput('early-exit', 'webm')
    const source = createFrameSource({ at: 0, color: 'red' })
    const exited = Promise.withResolvers<void>()
    const recorder = await recordScreencast(
      source.page,
      {
        ffmpegPath,
        format: 'webm',
        fps: 30,
        outputPath: output,
        quality: 30,
        scale: 1,
        speed: 1,
      },
      {
        monotonicNow: source.monotonicNow,
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
    for (let frame = 1; frame <= 30; frame += 1) {
      source.emit({ at: frame / 10, color: 'red' })
    }
    await exited.promise

    // Exit code 0, three seconds of frames captured, but FFmpeg never saw the
    // end of its input: the recording is incomplete, not transcoded.
    const stopped = await stopThroughEngine(recorder, output)
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

// ---------------------------------------------------------------------------
// Promotion: a spool that grows too large continues as a live encoder.
// ---------------------------------------------------------------------------

const LOW_FREE_BYTES = 1_000
const HIGH_FREE_BYTES = Number.MAX_SAFE_INTEGER
const PROMOTION_LIMITS = {
  promoteBytes: Number.MAX_SAFE_INTEGER,
  hardCapBytes: Number.MAX_SAFE_INTEGER,
  promoteFreeBytes: 2_000,
  stopFreeBytes: 500,
  // Every check reads the free space, so the test decides when to promote.
  freeCheckIntervalBytes: 1,
}

interface PromotedOptions {
  /** Aborts the recorder after the last frame, as a killed worker would. */
  readonly kill?: boolean
  /** The reference: the same script and pace, encoded live. */
  readonly live?: boolean
  readonly limits?: Partial<typeof PROMOTION_LIMITS>
  /**
   * When free space drops below the promotion floor: at segment start, or
   * after the frame at this index. `undefined` never promotes.
   */
  readonly promoteAt?: 'start' | number
  /** Stops before the replay has caught up, whatever the encoder does. */
  readonly stopAtOnce?: boolean
  /** The promoted encoder takes nothing until the recording has stopped. */
  readonly stalled?: boolean
  /** Waits for the switch before the next frame, or only before stop. */
  readonly waitFor?: 'switch' | 'stop'
}

/**
 * Like `recordScripted` for a spool with a promotion plan, but the script is
 * played asynchronously so the replay and the frames interleave.
 */
const recordPromoted = async (
  name: string,
  frames: readonly ScriptedFrame[],
  stopAt: number,
  options: PromotedOptions = {},
): Promise<{
  output: string
  recorder: ScreencastRecorder
  spoolPath: string
  warnings: string[]
}> => {
  const output = await reserveOutput(name, 'webm')
  const spoolPath = path.join(directory, `${name}.spool.mkv`)
  const warnings: string[] = []
  let free = options.promoteAt === 'start' ? LOW_FREE_BYTES : HIGH_FREE_BYTES
  const budget = new SpoolBudget(
    { ...PROMOTION_LIMITS, ...options.limits },
    { freeBytes: async () => free },
  )
  const plan: PromotionPlan = {
    ffmpegPath,
    plannedPath: output,
    remove: async (filePath) => {
      await fs.rm(filePath, { force: true })
    },
    // The placeholder reserved above, as the engine's reservation would give.
    reserveOutput: async () => output,
    warn: (message) => {
      warnings.push(message)
    },
  }
  const holdClock = createHoldClock()
  const source = createFrameSource(frames[0] as ScriptedFrame)
  const recorder = await recordScreencast(
    source.page,
    options.live
      ? { ...spoolSettings('webm', 1), outputPath: output }
      : { ...spoolSettings('webm', 1), budget, promotion: plan, spoolPath },
    {
      clock: holdClock.clock,
      monotonicNow: source.monotonicNow,
      ...(options.stalled
        ? {
            spawnProcess: (command: string, args: string[]) => {
              const child = spawnEncoder(command, args)
              stallInput(child)
              return child
            },
          }
        : {}),
    },
  )
  // Every step waits for the recorder to hand its blocks on, so a hold block
  // is written for each quiet second whatever the machine's pace: runs
  // compared with each other then have the same blocks.
  const pause = async (): Promise<void> => {
    await new Promise((resolve) => setImmediate(resolve))
    for (let turn = 0; turn < 5_000; turn += 1) {
      if (recorder.queueStats.pendingBlocks === 0) {
        return
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  const switched = (): Promise<void> =>
    waitFor(() => recorder.output.kind === 'encoded', 'the promotion to switch')
  const afterFrame = async (index: number): Promise<void> => {
    if (index === options.promoteAt) {
      free = LOW_FREE_BYTES
    }
    await pause()
    if (options.waitFor === 'switch' && recorder.output.kind === 'spool') {
      if (options.promoteAt === 'start' || index > (options.promoteAt ?? 0)) {
        await switched()
      }
    }
  }
  await afterFrame(0)
  let second = 1
  let index = 0
  for (const frame of frames.slice(1)) {
    for (; second < frame.at; second += 1) {
      source.setNow(second * 1_000)
      holdClock.hold()
      await pause()
    }
    index += 1
    source.emit(frame)
    await afterFrame(index)
  }
  for (; second <= stopAt; second += 1) {
    source.setNow(second * 1_000)
    holdClock.hold()
    await pause()
  }
  source.setNow(stopAt * 1_000)
  if (options.waitFor === 'stop' && !options.stopAtOnce) {
    await switched()
  }
  if (options.kill) {
    await waitFor(
      () => recorder.queueStats.pendingBlocks === 0,
      'the spool to take every block',
    )
    await new Promise((resolve) => setTimeout(resolve, 200))
    await recorder.abort()
  } else {
    await recorder.stop()
  }
  return { output, recorder, spoolPath, warnings }
}

/** The recording as a player gets it: encoded already, or its spool encoded. */
const finishPromoted = async (
  run: Awaited<ReturnType<typeof recordPromoted>>,
  name: string,
): Promise<string> => {
  const { recorder } = run
  if (recorder.output.kind === 'encoded') {
    expect(recorder.ffmpegResult.code).toBe(0)
    expect(recorder.incompleteReason).toBeUndefined()
    // A promoted recording leaves no spool.
    await expect(fs.access(run.spoolPath)).rejects.toThrow()
    return run.output
  }
  const output = await reserveOutput(`${name}-encoded`, 'webm')
  await encodeSpooled(recorder, output)
  return output
}

const expectSameTimeline = (
  actual: string,
  expected: string,
  fps: number,
): void => {
  const timeline = decodeColorTimeline(ffmpegPath, actual, fps, passthrough)
  const reference = decodeColorTimeline(ffmpegPath, expected, fps, passthrough)
  expect(timeline.spans).toEqual(reference.spans)
  expect(timeline.timestamps).toEqual(reference.timestamps)
  expect(readContainerDuration(ffmpegPath, actual)).toBe(
    readContainerDuration(ffmpegPath, expected),
  )
  expectFiniteDuration(actual, timeline, fps)
}

const PROMOTION_FRAMES: readonly ScriptedFrame[] = [
  { at: 0, color: 'red' },
  { at: 0.1, color: 'green' },
  { at: 0.2, color: 'red' },
  { at: 2, color: 'green' },
  { at: 2.05, color: 'blue' },
  { at: 2.1, color: 'red' },
  { at: 3, color: 'blue' },
]

describe('promoted recordings', () => {
  it.each([
    [
      'before the first block',
      { promoteAt: 'start', waitFor: 'switch' },
      'encoded',
    ],
    ['mid-stream', { promoteAt: 2, waitFor: 'switch' }, 'encoded'],
    ['during a burst', { promoteAt: 3, waitFor: 'stop' }, 'encoded'],
    // The stop races the replay: either side of it must show the same video.
    ['just before stop', { promoteAt: 6, stopAtOnce: true }, undefined],
    [
      'when stop arrives during the replay',
      { promoteAt: 3, stalled: true, stopAtOnce: true },
      'spool',
    ],
  ] as const)(
    'decode to the live timeline, promoted %s',
    async (title, options, outcome) => {
      const name = `promoted-${title.replaceAll(' ', '-')}`
      const live = await recordPromoted(`${name}-live`, PROMOTION_FRAMES, 5, {
        live: true,
      })
      const run = await recordPromoted(name, PROMOTION_FRAMES, 5, options)

      if (outcome) {
        expect(run.recorder.output.kind).toBe(outcome)
      }
      expect(run.warnings).toEqual([])
      expectSameTimeline(
        await finishPromoted(run, name),
        await finishPromoted(live, `${name}-live`),
        30,
      )
      // A segment that did not promote leaves no output behind but its own.
      if (run.recorder.output.kind === 'spool') {
        await expect(fs.access(run.output)).rejects.toThrow()
      }
    },
  )

  it('promotes a quiet recording with the timeline a live one has', async () => {
    const frames: readonly ScriptedFrame[] = [
      { at: 0, color: 'red' },
      { at: 35, color: 'green' },
    ]
    const reference = await recordPromoted('promoted-gap-ref', frames, 36, {
      live: true,
    })
    const run = await recordPromoted('promoted-gap', frames, 36, {
      promoteAt: 'start',
      waitFor: 'switch',
    })

    expect(run.recorder.output.kind).toBe('encoded')
    expectSameTimeline(
      await finishPromoted(run, 'promoted-gap'),
      await finishPromoted(reference, 'promoted-gap-ref'),
      30,
    )
  })

  it('ends the recording at the hard cap with every earlier span intact', async () => {
    const frames: readonly ScriptedFrame[] = [
      { at: 0, color: 'red' },
      { at: 1, color: 'green' },
      { at: 2, color: 'blue' },
      { at: 3, color: 'red' },
      { at: 4, color: 'green' },
      { at: 5, color: 'blue' },
    ]
    const full = await recordPromoted('cap-full', frames, 6)
    const fullSize = (await fs.stat(full.spoolPath)).size
    const capped = await recordPromoted('cap-capped', frames, 6, {
      limits: { hardCapBytes: Math.floor(fullSize * 0.6) },
    })

    expect(capped.recorder.incompleteReason).toMatch(
      /^The recording's frame spools reached the disk limit of .*; capture stopped after .*s to bound disk use\.$/u,
    )
    expect((await fs.stat(capped.spoolPath)).size).toBeLessThanOrEqual(
      Math.floor(fullSize * 0.6),
    )
    const spans = decodeColorTimeline(
      ffmpegPath,
      await finishPromoted(capped, 'cap-capped'),
      30,
      passthrough,
    ).spans
    const reference = decodeColorTimeline(
      ffmpegPath,
      await finishPromoted(full, 'cap-full'),
      30,
      passthrough,
    ).spans
    expect(spans.length).toBeGreaterThanOrEqual(2)
    expect(spans.length).toBeLessThan(reference.length)
    // Every span before the last is exactly what the whole recording shows.
    expect(spans.slice(0, -1)).toEqual(reference.slice(0, spans.length - 1))
    expect(spans.at(-1)?.color).toBe(reference[spans.length - 1]?.color)
  })

  it('leaves a spool that decodes to its newest held image when a crash comes during the replay', async () => {
    const run = await recordPromoted(
      'crash-replay',
      [
        { at: 0, color: 'red' },
        { at: 1, color: 'green' },
        { at: 2, color: 'blue' },
      ],
      8,
      { kill: true, promoteAt: 0, stalled: true },
    )

    expect(run.recorder.output.kind).toBe('spool')
    const output = await reserveOutput('crash-replay-encoded', 'webm')
    await encodeSpooled(run.recorder, output)
    const spans = decodeColorTimeline(ffmpegPath, output, 30, passthrough).spans
    expect(spans.slice(0, 2)).toEqual([
      { color: 'red', start: 0, end: 1 },
      { color: 'green', start: 1, end: 2 },
    ])
    // Blue is on disk, held until the last hold before the kill.
    expect(spans[2]).toEqual({ color: 'blue', start: 2, end: 6.533 })
    expect(spans).toHaveLength(3)
  })
})
