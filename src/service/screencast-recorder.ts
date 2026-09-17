import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import os from 'node:os'
import { PassThrough } from 'node:stream'
import type { CDPSession, Page } from 'puppeteer-core'
import type { CaptureCrop, OutputFormat } from '../types.js'
import { type ClockBoundary, systemClock } from './boundaries.js'
import { FFMPEG_TERMINATION_HELPER_TIMEOUT_MS } from './constants.js'
import {
  type TerminateFfmpegProcessTree,
  terminateFfmpegProcessTree,
} from './process-supervisor.js'

// Puppeteer resolves `page.screencast()` once the first frame arrives. Keep that
// ordering, but do not wait indefinitely for a tab that never paints.
const FIRST_FRAME_TIMEOUT_MS = 1_000
// Chrome can stamp a screencast's first frame with the time the page last
// painted, seconds before capture began. Never place a frame later than it
// arrived, measured from the first frame's arrival, beyond this delivery slack.
const TIMESTAMP_ARRIVAL_SLACK_SECONDS = 0.25
const FFMPEG_DIAGNOSTIC_LIMIT = 4_000

export interface ScreencastRecorderOptions {
  readonly crop?: Readonly<CaptureCrop>
  readonly ffmpegPath: string
  readonly format: OutputFormat
  readonly fps: number
  readonly quality: number
  readonly scale: number
  readonly speed: number
}

export interface ScreencastRecorderDependencies {
  readonly clock?: ClockBoundary
  readonly cpuCount?: () => number
  /** Monotonic milliseconds, used to bound frame timestamps and the final hold. */
  readonly monotonicNow?: () => number
  readonly spawnProcess?: (command: string, args: string[]) => ChildProcess
  readonly terminateProcessTree?: TerminateFfmpegProcessTree
}

interface ScreencastFrameEvent {
  readonly data: string
  readonly metadata: { readonly timestamp?: number }
  readonly sessionId: number
}

interface ReceivedFrame {
  readonly buffer: Buffer
  /** Seconds after the first frame at which this frame is shown. */
  readonly elapsedSeconds: number
  readonly receivedAt: number
  readonly timestamp: number
}

interface PixelDimensions {
  readonly devicePixelRatio: number
  readonly height: number
  readonly width: number
}

/**
 * Records a page's screencast into FFmpeg. Replaces Puppeteer 24's
 * `ScreenRecorder`, whose output does not play back in real time: it passes
 * `-framerate` after `-i`, so FFmpeg assumes 25 fps; it rounds each frame gap on
 * its own, dropping frames Chrome captures faster than `fps`; and its
 * `-avioflags direct` input makes FFmpeg discard the first two frames. Frames
 * are placed on a constant `fps` grid anchored at the first frame instead, using
 * Chrome's timestamps bounded by when each frame actually arrived.
 */
export class ScreencastRecorder extends PassThrough {
  private readonly ffmpeg: ChildProcess
  private readonly ffmpegClosed: Promise<void>
  private readonly fps: number
  private readonly monotonicNow: () => number
  private readonly session: CDPSession
  private readonly clock: ClockBoundary
  private readonly terminateProcessTree: TerminateFfmpegProcessTree
  private readonly cancelled = Promise.withResolvers<void>()
  private aborting: Promise<void> | undefined
  private detaching: Promise<void> | undefined
  private ffmpegDiagnostic = ''
  private first: ReceivedFrame | undefined
  private latest: ReceivedFrame | undefined
  private received = 0
  private stopping: Promise<void> | undefined
  private stopped = false
  private resolveFirstFrame: (() => void) | undefined

  constructor(
    session: CDPSession,
    ffmpeg: ChildProcess,
    fps: number,
    monotonicNow: () => number,
    dependencies: Pick<
      ScreencastRecorderDependencies,
      'clock' | 'terminateProcessTree'
    > = {},
  ) {
    super({ allowHalfOpen: false })
    this.session = session
    this.ffmpeg = ffmpeg
    this.fps = fps
    this.monotonicNow = monotonicNow
    this.clock = dependencies.clock ?? systemClock
    this.terminateProcessTree =
      dependencies.terminateProcessTree ?? terminateFfmpegProcessTree
    this.ffmpegClosed = new Promise((resolve) => {
      ffmpeg.once('close', () => {
        resolve()
      })
    })
    // A write after FFmpeg exits must not crash the worker; the recording is
    // reported through the stream it produced.
    ffmpeg.stdin?.on('error', () => undefined)
    ffmpeg.stderr?.on('data', (chunk: Buffer) => {
      this.ffmpegDiagnostic = (this.ffmpegDiagnostic + chunk.toString()).slice(
        -FFMPEG_DIAGNOSTIC_LIMIT,
      )
    })
    ffmpeg.stdout?.pipe(this)
    session.on('Page.screencastFrame', this.onFrame)
  }

  /** Frames Chrome has delivered with a timestamp since recording started. */
  get frameCount(): number {
    return this.received
  }

  /** FFmpeg's exit code and the end of its error output, once it has exited. */
  get ffmpegResult(): { code: number | null; diagnostic: string } {
    return {
      code: this.ffmpeg.exitCode,
      diagnostic: this.ffmpegDiagnostic.trim(),
    }
  }

  /** Resolves once the first frame arrives or the wait for it times out. */
  async waitForFirstFrame(clock: ClockBoundary): Promise<void> {
    if (this.received > 0) {
      return
    }
    const { promise: firstFrame, resolve } = Promise.withResolvers<void>()
    this.resolveFirstFrame = resolve
    const timer = clock.setTimeout(resolve, FIRST_FRAME_TIMEOUT_MS)
    timer.unref?.()
    try {
      await firstFrame
    } finally {
      clock.clearTimeout(timer)
      this.resolveFirstFrame = undefined
    }
  }

  async stop(): Promise<void> {
    this.stopping ??= this.finish()
    await this.stopping
  }

  /** Abandon a failed stop without leaving an encoder holding the worker open. */
  abort(): Promise<void> {
    this.aborting ??= Promise.resolve().then(() => this.abortRecording())
    return this.aborting
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.stopped = true
    this.session.off('Page.screencastFrame', this.onFrame)
    // Normal stream auto-destruction can precede FFmpeg's close event. An
    // explicit destroy during stop is different: it must still cancel stop.
    if (!this.readableEnded || !this.writableFinished) {
      void this.abort()
    }
    void this.detachSession()
    callback(error)
  }

  private async abortRecording(): Promise<void> {
    this.stopped = true
    this.session.off('Page.screencastFrame', this.onFrame)
    this.cancelled.resolve()
    this.ffmpeg.stdout?.unpipe(this)
    this.ffmpeg.stdin?.destroy()
    this.destroy()
    try {
      if (this.ffmpeg.exitCode === null && this.ffmpeg.signalCode === null) {
        // The engine already allowed a graceful stop. Force only this owned
        // encoder tree; never kill other workers' FFmpeg/browser processes.
        await this.terminateProcessTree(this.ffmpeg, true)
        await this.waitForEncoderClose()
      }
    } finally {
      this.ffmpeg.stdout?.destroy()
      this.ffmpeg.stderr?.destroy()
      this.ffmpeg.unref()
    }
  }

  private async waitForEncoderClose(): Promise<void> {
    const { promise: expired, resolve } = Promise.withResolvers<void>()
    const timer = this.clock.setTimeout(
      resolve,
      FFMPEG_TERMINATION_HELPER_TIMEOUT_MS,
    )
    timer.unref?.()
    try {
      await Promise.race([this.ffmpegClosed, expired])
    } finally {
      this.clock.clearTimeout(timer)
    }
  }

  private detachSession(): Promise<void> {
    this.detaching ??= this.session.detach().catch(() => undefined)
    return this.detaching
  }

  private readonly onFrame = (event: ScreencastFrameEvent): void => {
    void this.session
      .send('Page.screencastFrameAck', { sessionId: event.sessionId })
      .catch(() => undefined)
    const timestamp = event.metadata.timestamp
    if (
      this.stopped ||
      typeof timestamp !== 'number' ||
      !Number.isFinite(timestamp)
    ) {
      return
    }
    const previous = this.latest
    const receivedAt = this.monotonicNow()
    const first = this.first
    const frame: ReceivedFrame = {
      buffer: Buffer.from(event.data, 'base64'),
      elapsedSeconds: first
        ? Math.max(
            // A timestamp that runs backwards would otherwise rewind the grid.
            previous?.elapsedSeconds ?? 0,
            Math.min(
              timestamp - first.timestamp,
              (receivedAt - first.receivedAt) / 1_000 +
                TIMESTAMP_ARRIVAL_SLACK_SECONDS,
            ),
          )
        : 0,
      receivedAt,
      timestamp,
    }
    if (previous) {
      this.writeFrame(
        previous.buffer,
        this.gridPosition(frame.elapsedSeconds) -
          this.gridPosition(previous.elapsedSeconds),
      )
    } else {
      this.first = frame
    }
    this.latest = frame
    this.received += 1
    this.resolveFirstFrame?.()
  }

  private async finish(): Promise<void> {
    // Stopping the screencast flushes frames already in flight.
    await Promise.race([
      this.session.send('Page.stopScreencast').catch(() => undefined),
      this.cancelled.promise,
    ])
    if (this.aborting) {
      await this.aborting
      return
    }
    this.stopped = true
    this.session.off('Page.screencastFrame', this.onFrame)
    const latest = this.latest
    if (latest) {
      // Hold the final frame until now. Measure locally, so a remote browser's
      // clock cannot skew the recording's length.
      const heldSeconds = (this.monotonicNow() - latest.receivedAt) / 1_000
      const end = this.gridPosition(latest.elapsedSeconds + heldSeconds)
      this.writeFrame(
        latest.buffer,
        Math.max(1, end - this.gridPosition(latest.elapsedSeconds)),
      )
    }
    this.ffmpeg.stdin?.end()
    await Promise.race([this.ffmpegClosed, this.cancelled.promise])
    if (this.aborting) {
      await this.aborting
      return
    }
    await Promise.race([this.detachSession(), this.cancelled.promise])
  }

  private gridPosition(elapsedSeconds: number): number {
    return Math.round(elapsedSeconds * this.fps)
  }

  private writeFrame(buffer: Buffer, copies: number): void {
    const stdin = this.ffmpeg.stdin
    if (!stdin || stdin.writableEnded) {
      return
    }
    for (let copy = 0; copy < copies; copy += 1) {
      stdin.write(buffer)
    }
  }
}

export const recordScreencast = async (
  page: Page,
  options: ScreencastRecorderOptions,
  dependencies: ScreencastRecorderDependencies = {},
): Promise<ScreencastRecorder> => {
  const clock = dependencies.clock ?? systemClock
  const dimensions = await readNativePixelDimensions(page)
  const crop = options.crop
    ? toDevicePixelCrop(options.crop, dimensions)
    : undefined
  const ffmpeg = (dependencies.spawnProcess ?? spawnFfmpeg)(
    options.ffmpegPath,
    createFfmpegArguments(
      options,
      dimensions,
      crop,
      (dependencies.cpuCount ?? (() => os.cpus().length))(),
    ),
  )
  let session: CDPSession | undefined
  let recorder: ScreencastRecorder | undefined
  try {
    await once(ffmpeg, 'spawn')
    session = await page.createCDPSession()
    recorder = new ScreencastRecorder(
      session,
      ffmpeg,
      options.fps,
      dependencies.monotonicNow ?? (() => performance.now()),
      dependencies,
    )
    await session.send('Page.startScreencast', { format: 'png' })
    await recorder.waitForFirstFrame(clock)
    return recorder
  } catch (error) {
    if (recorder) {
      await recorder.abort()
    } else {
      ffmpeg.kill()
      await session?.detach().catch(() => undefined)
    }
    throw error
  }
}

export const createFfmpegArguments = (
  options: Pick<ScreencastRecorderOptions, 'format' | 'fps' | 'quality'> &
    Partial<Pick<ScreencastRecorderOptions, 'scale' | 'speed'>>,
  dimensions: Pick<PixelDimensions, 'width' | 'height'>,
  crop: Readonly<CaptureCrop> | undefined,
  cpuCount: number,
): string[] => {
  const { width, height } = dimensions
  const filters = [
    `crop='min(${width},iw):min(${height},ih):0:0'`,
    `pad=${width}:${height}:0:0`,
  ]
  if (options.speed) {
    filters.push(`setpts=${1 / options.speed}*PTS`)
  }
  if (crop) {
    filters.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`)
  }
  if (options.scale) {
    filters.push(`scale=iw*${options.scale}:-1:flags=lanczos`)
  }
  return [
    ['-loglevel', 'error'],
    // `-framerate` is an input option: after `-i`, FFmpeg ignores it and plays
    // piped images at 25 fps. Keep input buffering and probing at their
    // defaults; `-avioflags direct` or a tiny probe size loses the first frames.
    ['-framerate', `${options.fps}`, '-f', 'image2pipe'],
    ['-vcodec', 'png', '-i', 'pipe:0'],
    ['-an', '-threads', '1', '-b:v', '0'],
    ['-vcodec', 'vp9', '-crf', `${options.quality}`],
    ['-deadline', 'realtime'],
    ['-cpu-used', `${Math.max(1, Math.min(Math.floor(cpuCount / 2), 8))}`],
    options.format === 'mp4'
      ? ['-movflags', 'hybrid_fragmented', '-f', 'mp4']
      : ['-f', 'webm'],
    ['-vf', filters.join()],
    ['-y', 'pipe:1'],
  ].flat()
}

const spawnFfmpeg = (command: string, args: string[]): ChildProcess => {
  return spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
}

// Mirrors Puppeteer: measure the viewport at the device's native pixel ratio,
// then restore any emulated one.
const readNativePixelDimensions = async (
  page: Page,
): Promise<PixelDimensions> => {
  const viewport = page.viewport()
  const emulatedViewport =
    viewport && viewport.deviceScaleFactor !== 0 ? viewport : undefined
  if (emulatedViewport) {
    await page.setViewport({ ...emulatedViewport, deviceScaleFactor: 0 })
  }
  try {
    return await page.evaluate((): PixelDimensions => {
      const view = globalThis as typeof globalThis & {
        devicePixelRatio: number
        visualViewport: { width: number; height: number }
      }
      return {
        devicePixelRatio: view.devicePixelRatio,
        height: view.visualViewport.height * view.devicePixelRatio,
        width: view.visualViewport.width * view.devicePixelRatio,
      }
    })
  } finally {
    if (emulatedViewport) {
      await page.setViewport(emulatedViewport).catch(() => undefined)
    }
  }
}

// Same bounds and messages as Puppeteer's `page.screencast()`; the capture
// layer recognizes crop failures by their "`crop." prefix.
const toDevicePixelCrop = (
  requested: Readonly<CaptureCrop>,
  dimensions: PixelDimensions,
): CaptureCrop => {
  const normalizedX =
    requested.width < 0 ? requested.x + requested.width : requested.x
  const normalizedY =
    requested.height < 0 ? requested.y + requested.height : requested.y
  const normalizedWidth = Math.abs(requested.width)
  const normalizedHeight = Math.abs(requested.height)
  const x = Math.round(normalizedX)
  const y = Math.round(normalizedY)
  const width = Math.round(normalizedWidth + normalizedX - x)
  const height = Math.round(normalizedHeight + normalizedY - y)
  if (x < 0 || y < 0) {
    throw new Error('`crop.x` and `crop.y` must be greater than or equal to 0.')
  }
  if (width <= 0 || height <= 0) {
    throw new Error(
      '`crop.height` and `crop.width` must be greater than or equal to 0.',
    )
  }
  const { devicePixelRatio } = dimensions
  const viewportWidth = dimensions.width / devicePixelRatio
  const viewportHeight = dimensions.height / devicePixelRatio
  if (x + width > viewportWidth) {
    throw new Error(
      `\`crop.width\` cannot be larger than the viewport width (${viewportWidth}).`,
    )
  }
  if (y + height > viewportHeight) {
    throw new Error(
      `\`crop.height\` cannot be larger than the viewport height (${viewportHeight}).`,
    )
  }
  return {
    x: x * devicePixelRatio,
    y: y * devicePixelRatio,
    width: width * devicePixelRatio,
    height: height * devicePixelRatio,
  }
}
