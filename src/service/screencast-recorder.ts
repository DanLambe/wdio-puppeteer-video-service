import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import os from 'node:os'
import { PassThrough } from 'node:stream'
import type { CDPSession, Page } from 'puppeteer-core'
import type { CaptureCrop, OutputFormat } from '../types.js'
import { type ClockBoundary, systemClock } from './boundaries.js'

// Puppeteer resolves `page.screencast()` once the first frame arrives. Keep that
// ordering, but do not wait indefinitely for a tab that never paints.
const FIRST_FRAME_TIMEOUT_MS = 1_000

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
  /** Monotonic milliseconds, used to measure how long the last frame is held. */
  readonly monotonicNow?: () => number
  readonly spawnProcess?: (command: string, args: string[]) => ChildProcess
}

interface ScreencastFrameEvent {
  readonly data: string
  readonly metadata: { readonly timestamp?: number }
  readonly sessionId: number
}

interface ReceivedFrame {
  readonly buffer: Buffer
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
 * are placed on a constant `fps` grid anchored at the first frame instead.
 */
export class ScreencastRecorder extends PassThrough {
  private readonly ffmpeg: ChildProcess
  private readonly ffmpegClosed: Promise<void>
  private readonly fps: number
  private readonly monotonicNow: () => number
  private readonly session: CDPSession
  private firstTimestamp = 0
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
  ) {
    super({ allowHalfOpen: false })
    this.session = session
    this.ffmpeg = ffmpeg
    this.fps = fps
    this.monotonicNow = monotonicNow
    this.ffmpegClosed = new Promise((resolve) => {
      ffmpeg.once('close', () => {
        resolve()
      })
    })
    // A write after FFmpeg exits must not crash the worker; the recording is
    // reported through the stream it produced.
    ffmpeg.stdin?.on('error', () => undefined)
    ffmpeg.stdout?.pipe(this)
    session.on('Page.screencastFrame', this.onFrame)
  }

  /** Frames Chrome has delivered with a timestamp since recording started. */
  get frameCount(): number {
    return this.received
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

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.stopped = true
    this.session.off('Page.screencastFrame', this.onFrame)
    // A graceful stop ends FFmpeg's output before the process reports its exit;
    // only an abandoned recording needs the process killed.
    if (
      !this.stopping &&
      this.ffmpeg.exitCode === null &&
      this.ffmpeg.signalCode === null
    ) {
      this.ffmpeg.kill()
    }
    void this.session.detach().catch(() => undefined)
    callback(error)
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
    const frame: ReceivedFrame = {
      buffer: Buffer.from(event.data, 'base64'),
      receivedAt: this.monotonicNow(),
      // A timestamp that runs backwards would otherwise rewind the grid.
      timestamp: Math.max(timestamp, previous?.timestamp ?? timestamp),
    }
    if (previous) {
      this.writeFrame(
        previous.buffer,
        this.gridPosition(frame.timestamp) -
          this.gridPosition(previous.timestamp),
      )
    } else {
      this.firstTimestamp = frame.timestamp
    }
    this.latest = frame
    this.received += 1
    this.resolveFirstFrame?.()
  }

  private async finish(): Promise<void> {
    // Stopping the screencast flushes frames already in flight.
    await this.session.send('Page.stopScreencast').catch(() => undefined)
    this.stopped = true
    this.session.off('Page.screencastFrame', this.onFrame)
    const latest = this.latest
    if (latest) {
      // Hold the final frame until now. Measure locally, so a remote browser's
      // clock cannot skew the recording's length.
      const heldSeconds = (this.monotonicNow() - latest.receivedAt) / 1_000
      const end = Math.round(
        (latest.timestamp - this.firstTimestamp + heldSeconds) * this.fps,
      )
      this.writeFrame(
        latest.buffer,
        Math.max(1, end - this.gridPosition(latest.timestamp)),
      )
    }
    this.ffmpeg.stdin?.end()
    await this.ffmpegClosed
    await this.session.detach().catch(() => undefined)
  }

  private gridPosition(timestamp: number): number {
    return Math.round((timestamp - this.firstTimestamp) * this.fps)
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
    )
    await session.send('Page.startScreencast', { format: 'png' })
    await recorder.waitForFirstFrame(clock)
    return recorder
  } catch (error) {
    if (recorder) {
      recorder.destroy()
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
    stdio: ['pipe', 'pipe', 'ignore'],
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
