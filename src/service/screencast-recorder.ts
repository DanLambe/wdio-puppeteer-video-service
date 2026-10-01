import { type ChildProcess, spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import type { CDPSession, Page } from 'puppeteer-core'
import type { CaptureCrop, OutputFormat } from '../types.js'
import { type ClockBoundary, systemClock } from './boundaries.js'
import { createMatroskaHeader, MatroskaBlockWriter } from './matroska-writer.js'
import type { TerminateFfmpegProcessTree } from './process-supervisor.js'
import { type FfmpegResult, ScreencastEncoder } from './screencast-encoder.js'

export type { FfmpegResult } from './screencast-encoder.js'

// Puppeteer resolves `page.screencast()` once the first frame arrives. Keep that
// ordering, but do not wait indefinitely for a tab that never paints.
const FIRST_FRAME_TIMEOUT_MS = 1_000
// libvpx's fastest realtime speed. Puppeteer derives it from the host's CPU
// count, so a 4-CPU CI runner encodes 1080p VP9 at about 7 frames per second on
// one core: slower than the capture rate, so every stop has a backlog to drain.
// On a busy full-HD test page, speed 8 encoded about 13 times faster than speed
// 2 at near-identical SSIM, with files about 2.7 times larger.
const VP9_REALTIME_SPEED = 8
// Chrome can stamp a screencast's first frame with the time the page last
// painted, seconds before capture began. Never place a frame later than it
// arrived, measured from the first frame's arrival, beyond this delivery slack.
const TIMESTAMP_ARRIVAL_SLACK_SECONDS = 0.25
// Owned-session operations only; viewport restoration must remain awaited.
const CDP_STARTUP_TIMEOUT_MS = 10_000
// Chrome sends no frames while a page is static, so the last frame's duration is
// only known when another frame arrives or the recording stops. Mark it on this
// cadence so a recording cut short by a crashed worker still covers the quiet
// tail. Stay this far behind real time so a frame that arrives a little late
// still starts at its own timestamp.
const HOLD_INTERVAL_MS = 1_000
const HOLD_LAG_SECONDS = 0.5
// Consecutive writes the encoder accepted before yielding to the event loop.
const WRITE_BATCH = 32

export interface ScreencastRecorderOptions {
  readonly crop?: Readonly<CaptureCrop>
  readonly ffmpegPath: string
  readonly format: OutputFormat
  readonly fps: number
  /** Bounds the dimensions Chrome is asked to produce for each frame. */
  readonly maxWidth?: number
  readonly maxHeight?: number
  readonly quality: number
  readonly scale: number
  readonly speed: number
}

/** The frame size Chrome is asked to deliver. */
export interface CaptureCanvas {
  readonly width: number
  readonly height: number
}

/**
 * Chrome's `maxWidth`/`maxHeight` shrink a frame to fit inside the box while
 * preserving its aspect ratio, and never enlarge one. Mirror that here so the
 * encoder's canvas matches what Chrome will actually send. Dimensions are
 * rounded to even numbers because odd ones force the encoder to pad; the
 * recorder's `crop`/`pad` filter absorbs any remaining pixel of disagreement.
 *
 * Chrome recomputes the bound against whatever the viewport is when it composites
 * each frame, so the scale factor is not fixed for the recording. The FFmpeg
 * filter chain is built once at spawn time, which is why `capture.crop` cannot be
 * combined with a bound: a crop rectangle scaled for the start-time viewport
 * selects the wrong region as soon as the viewport changes. Option validation
 * rejects that pair rather than publishing a healthy recording of a different
 * region.
 */
export const resolveCaptureCanvas = (
  dimensions: Pick<PixelDimensions, 'width' | 'height'>,
  maxWidth: number | undefined,
  maxHeight: number | undefined,
): CaptureCanvas => {
  const ratio = Math.min(
    1,
    maxWidth === undefined || dimensions.width <= 0
      ? 1
      : maxWidth / dimensions.width,
    maxHeight === undefined || dimensions.height <= 0
      ? 1
      : maxHeight / dimensions.height,
  )
  if (ratio >= 1 || Number.isNaN(ratio)) {
    return { width: dimensions.width, height: dimensions.height }
  }
  const toEven = (value: number): number =>
    Math.max(2, Math.round((value * ratio) / 2) * 2)
  return { width: toEven(dimensions.width), height: toEven(dimensions.height) }
}

export interface ScreencastQueueLimits {
  /** Payload of distinct frames retained by pending writes and the held frame. */
  readonly maxPendingBytes: number
  /**
   * Frame blocks waiting to be handed to the encoder while capturing. Stop may
   * queue two more, which show the held frame and add no payload.
   */
  readonly maxPendingBlocks: number
}

const DEFAULT_SCREENCAST_QUEUE_LIMITS: ScreencastQueueLimits = {
  maxPendingBytes: 64 * 1024 * 1024,
  maxPendingBlocks: 1_024,
}

export interface ScreencastRecorderDependencies {
  readonly clock?: ClockBoundary
  /** Monotonic milliseconds, used to bound frame timestamps and the final hold. */
  readonly monotonicNow?: () => number
  readonly queueLimits?: Partial<ScreencastQueueLimits>
  readonly spawnProcess?: (command: string, args: string[]) => ChildProcess
  readonly terminateProcessTree?: TerminateFfmpegProcessTree
}

/** Encoder queue measurements for diagnostics; high-water marks never fall. */
export interface ScreencastQueueStats {
  readonly highWaterBlocks: number
  readonly highWaterBytes: number
  /** Most capture time waiting for the encoder, from its oldest pending block. */
  readonly highWaterLagSeconds: number
  readonly pendingBlocks: number
  readonly pendingBytes: number
}

interface ScreencastFrameEvent {
  readonly data: string
  readonly metadata: { readonly timestamp?: number }
  readonly sessionId: number
}

interface ReceivedFrame {
  /** Chrome's base64 payload, released once decoded. */
  data: string | undefined
  /** The decoded image, produced when the frame is first queued. */
  encoded: Buffer | undefined
  /** Seconds after the first frame at which this frame is shown. */
  readonly elapsedSeconds: number
  readonly receivedAt: number
  readonly timestamp: number
}

interface PendingBlock {
  readonly frame: ReceivedFrame
  readonly position: number
}

// Base64 is ASCII, which V8 stores at one byte per character; a decoded frame
// costs its length. A frame is counted once however many blocks reference it.
const frameCost = (frame: ReceivedFrame): number => {
  return frame.encoded?.length ?? frame.data?.length ?? 0
}

// Chrome delivers frames faster than `fps` on a busy page, and only the frames
// that land on a new grid position are ever written. Decoding when a frame is
// first queued keeps the base64 of a superseded frame from being turned into a
// buffer that nothing consumes.
const frameBytes = (frame: ReceivedFrame): Buffer => {
  frame.encoded ??= Buffer.from(frame.data ?? '', 'base64')
  frame.data = undefined
  return frame.encoded
}

interface PixelDimensions {
  readonly devicePixelRatio: number
  readonly height: number
  readonly width: number
}

export interface ScreencastRecorderInit {
  /** The frame size FFmpeg is told to expect. */
  readonly canvas: CaptureCanvas
  readonly clock?: ClockBoundary
  readonly encoder?: ScreencastEncoder
  readonly ffmpeg: ChildProcess
  readonly fps: number
  readonly monotonicNow: () => number
  readonly queueLimits?: Partial<ScreencastQueueLimits>
  readonly session: CDPSession
  /** Playback speed; applied to frame timestamps, so FFmpeg never retimes. */
  readonly speed?: number
  readonly terminateProcessTree?: TerminateFfmpegProcessTree
}

/**
 * Records a page's screencast into FFmpeg. Replaces Puppeteer 24's
 * `ScreenRecorder`, whose output does not play back in real time: it passes
 * `-framerate` after `-i`, so FFmpeg assumes 25 fps; it rounds each frame gap on
 * its own, dropping frames Chrome captures faster than `fps`; and its
 * `-avioflags direct` input makes FFmpeg discard the first two frames.
 *
 * Frames are placed on an `fps` grid anchored at the first frame, using
 * Chrome's timestamps bounded by when each frame actually arrived. Each
 * distinct frame reaches FFmpeg once, stamped with its grid position, and the
 * video holds it until the next one: an unchanged page costs the encoder
 * nothing per grid position. Writes wait for the encoder's input to drain, and
 * the frames waiting on it are bounded; past either limit capture stops and
 * the recording is reported incomplete rather than growing without bound. An
 * encoder that exits before the recording is stopped leaves it incomplete too.
 */
export class ScreencastRecorder extends PassThrough {
  private readonly ffmpeg: ChildProcess
  private readonly encoder: ScreencastEncoder
  private readonly fps: number
  // Output frames per second: capture positions are spaced `1 / fps` apart
  // in capture time and `1 / playbackRate` apart in the video.
  private readonly playbackRate: number
  private readonly limits: ScreencastQueueLimits
  private readonly monotonicNow: () => number
  private readonly session: CDPSession
  private readonly clock: ClockBoundary
  private readonly blocks = new MatroskaBlockWriter()
  private readonly cancelled = Promise.withResolvers<void>()
  private readonly pending: PendingBlock[] = []
  // Distinct frames referenced by pending blocks, with their block counts.
  private readonly pendingFrames = new Map<ReceivedFrame, number>()
  private aborting: Promise<void> | undefined
  private detaching: Promise<void> | undefined
  private emitted = 0
  private firstReceivedAt: number | undefined
  private firstTimestamp = 0
  private highWaterBlocks = 0
  private highWaterBytes = 0
  private highWaterLag = 0
  private holdTimer: NodeJS.Timeout | undefined
  private incomplete: string | undefined
  private inputEnded = false
  private lastBlockPosition = -1
  private latest: ReceivedFrame | undefined
  private latestEmitted = false
  private previousBlockPosition = -1
  private draining = false
  private idle: PromiseWithResolvers<void> | undefined
  private received = 0
  private stopping: Promise<void> | undefined
  private stopped = false
  private resolveFirstFrame: (() => void) | undefined

  constructor(init: ScreencastRecorderInit) {
    super({ allowHalfOpen: false })
    this.session = init.session
    this.ffmpeg = init.ffmpeg
    this.fps = init.fps
    this.playbackRate = init.fps * (init.speed ?? 1)
    this.monotonicNow = init.monotonicNow
    this.clock = init.clock ?? systemClock
    this.limits = { ...DEFAULT_SCREENCAST_QUEUE_LIMITS, ...init.queueLimits }
    this.encoder =
      init.encoder ??
      new ScreencastEncoder(init.ffmpeg, {
        ...(init.clock ? { clock: init.clock } : {}),
        ...(init.terminateProcessTree
          ? { terminateProcessTree: init.terminateProcessTree }
          : {}),
      })
    init.ffmpeg.stdin?.write(
      createMatroskaHeader({
        codec: 'png',
        fps: this.playbackRate,
        ...init.canvas,
      }),
    )
    init.ffmpeg.stdout?.pipe(this)
    init.session.on('Page.screencastFrame', this.onFrame)
    // An encoder that exits early can take nothing more: stop retaining frames.
    void this.encoder.closed.then(this.onEncoderClosed)
  }

  /** Frames Chrome has delivered with a timestamp since recording started. */
  get frameCount(): number {
    return this.received
  }

  /** How FFmpeg exited, once it has, and the end of its error output. */
  get ffmpegResult(): FfmpegResult {
    return this.encoder.result
  }

  /** Why capture stopped before the recording was stopped, if it did. */
  get incompleteReason(): string | undefined {
    return this.incomplete
  }

  get queueStats(): ScreencastQueueStats {
    return {
      highWaterBlocks: this.highWaterBlocks,
      highWaterBytes: this.highWaterBytes,
      highWaterLagSeconds: this.highWaterLag / this.fps,
      pendingBlocks: this.pending.length,
      pendingBytes: this.retainedBytes(),
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
    // Its close event may still be on its way. Report an exit that came
    // first, but never the termination this requests.
    if (this.encoderExited) {
      this.noteEarlyExit()
    }
    this.aborting ??= Promise.resolve().then(() => this.abortRecording())
    return this.aborting
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.stopCapturing()
    // Normal stream auto-destruction can precede FFmpeg's close event. An
    // explicit destroy during stop is different: it must still cancel stop.
    if (!this.readableEnded || !this.writableFinished) {
      void this.abort()
    }
    void this.detachSession()
    callback(error)
  }

  private async abortRecording(): Promise<void> {
    this.stopCapturing()
    this.cancelled.resolve()
    this.resolveFirstFrame?.()
    this.releasePending()
    this.ffmpeg.stdout?.unpipe(this)
    this.destroy()
    await this.encoder.abort()
  }

  private detachSession(): Promise<void> {
    this.detaching ??= this.session.detach().catch(() => undefined)
    return this.detaching
  }

  private stopCapturing(): void {
    this.stopped = true
    this.stopHolding()
    this.session.off('Page.screencastFrame', this.onFrame)
  }

  private readonly onEncoderClosed = (): void => {
    this.noteEarlyExit()
    if (this.stopping || this.aborting) {
      return
    }
    this.stopCapturing()
    this.releasePending()
    void this.session.send('Page.stopScreencast').catch(() => undefined)
  }

  private get encoderExited(): boolean {
    return this.ffmpeg.exitCode !== null || this.ffmpeg.signalCode !== null
  }

  // Only stop ends FFmpeg's input, so an encoder that exits before then has
  // not encoded the whole recording, whatever its exit code. Abort terminates
  // it on purpose.
  private noteEarlyExit(): void {
    if (this.inputEnded || this.aborting || this.incomplete) {
      return
    }
    const { code, diagnostic, signal } = this.encoder.result
    const exit = signal
      ? `was terminated by ${signal}`
      : `exited with code ${String(code)}`
    this.incomplete = `FFmpeg ${exit} before the recording was stopped${diagnostic ? `: ${diagnostic}` : '.'}`
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
    const firstReceivedAt = this.firstReceivedAt
    const frame: ReceivedFrame = {
      data: event.data,
      encoded: undefined,
      elapsedSeconds:
        firstReceivedAt === undefined
          ? 0
          : Math.max(
              // A timestamp that runs backwards would otherwise rewind the grid.
              previous?.elapsedSeconds ?? 0,
              Math.min(
                timestamp - this.firstTimestamp,
                (receivedAt - firstReceivedAt) / 1_000 +
                  TIMESTAMP_ARRIVAL_SLACK_SECONDS,
              ),
            ),
      receivedAt,
      timestamp,
    }
    if (previous) {
      this.fillTo(previous, this.gridPosition(frame.elapsedSeconds))
    } else {
      this.firstReceivedAt = receivedAt
      this.firstTimestamp = timestamp
      this.startHolding()
    }
    this.received += 1
    this.resolveFirstFrame?.()
    const overload = this.overloadFor(frame)
    if (overload) {
      // The previous frame already has its span; this one would start where
      // the recording now ends.
      this.overload(overload)
      return
    }
    this.latest = frame
    this.latestEmitted = false
    this.recordHighWater()
  }

  private async finish(): Promise<void> {
    // Stopping the screencast flushes frames already in flight.
    await Promise.race([
      this.session.send('Page.stopScreencast').catch(() => undefined),
      this.cancelled.promise,
    ])
    if (await this.wasAborted()) {
      return
    }
    const capturing = !this.stopped
    this.stopCapturing()
    const { firstReceivedAt, latest } = this
    if (latest && firstReceivedAt !== undefined) {
      // Show the final frame at least once, from where it starts. End markers
      // written before it would show it in the previous frame's span.
      let end = this.latestEmitted ? 0 : this.emitted + 1
      if (capturing) {
        // Hold the final frame until now. A frame Chrome delivered late must
        // not end the video before the capture's elapsed time. Only stop uses
        // that bound: applied while capturing, it would run the timeline ahead
        // of late frames and drop them. Capture that stopped early ends there.
        end = Math.max(
          end,
          this.heldPosition(latest, 0),
          this.gridPosition((this.monotonicNow() - firstReceivedAt) / 1_000),
        )
      }
      this.fillTo(latest, end)
      this.writeEnd(latest)
    }
    await Promise.race([this.pump(), this.cancelled.promise])
    if (await this.wasAborted()) {
      return
    }
    // Everything is with the encoder; the held frame is no longer needed.
    this.releasePending()
    if (this.encoderExited) {
      this.noteEarlyExit()
    }
    this.inputEnded = true
    this.ffmpeg.stdin?.end()
    await Promise.race([this.encoder.closed, this.cancelled.promise])
    if (await this.wasAborted()) {
      return
    }
    await Promise.race([this.detachSession(), this.cancelled.promise])
  }

  // Awaited between steps, so TypeScript would otherwise keep `aborting`
  // narrowed to its value before the await.
  private async wasAborted(): Promise<boolean> {
    const aborting = this.aborting
    if (!aborting) {
      return false
    }
    await aborting
    return true
  }

  private startHolding(): void {
    this.holdTimer = this.clock.setInterval(this.holdLatest, HOLD_INTERVAL_MS)
    this.holdTimer.unref?.()
  }

  private stopHolding(): void {
    if (this.holdTimer) {
      this.clock.clearInterval(this.holdTimer)
      this.holdTimer = undefined
    }
  }

  private readonly holdLatest = (): void => {
    const latest = this.latest
    if (this.stopped || !latest) {
      return
    }
    this.fillTo(latest, this.heldPosition(latest, HOLD_LAG_SECONDS))
  }

  // Where the held frame ends now, measured on the local clock so a remote
  // browser's clock cannot skew the recording's length.
  private heldPosition(frame: ReceivedFrame, lagSeconds: number): number {
    const heldSeconds = (this.monotonicNow() - frame.receivedAt) / 1_000
    return this.gridPosition(frame.elapsedSeconds + heldSeconds - lagSeconds)
  }

  private gridPosition(elapsedSeconds: number): number {
    return Math.round(elapsedSeconds * this.fps)
  }

  // Extends the timeline with `frame` up to grid `position`, queueing one block
  // at the start of the new range. The timeline only moves forward: a frame
  // placed before positions already assigned is not shown. While the newest
  // block waiting for the encoder already shows `frame`, the video holds it
  // from there either way, so a stalled encoder does not collect a block per
  // hold of an unchanged page.
  private fillTo(frame: ReceivedFrame, position: number): void {
    if (position <= this.emitted) {
      return
    }
    if (this.pending.at(-1)?.frame !== frame) {
      this.enqueue(frame, this.emitted)
    }
    this.emitted = position
    if (frame === this.latest) {
      this.latestEmitted = true
    }
    this.recordLag()
  }

  // The last frame lasts as long as the gap before it, to a player or a
  // transcoder. End on two blocks one grid step apart so that gap is exact; if
  // the final block already stands alone, extend by one step rather than
  // stretching it by a whole hold interval.
  private writeEnd(latest: ReceivedFrame): void {
    const end = this.emitted
    if (this.lastBlockPosition < end - 2) {
      this.enqueue(latest, end - 2)
    }
    if (this.lastBlockPosition < end - 1) {
      this.enqueue(latest, end - 1)
    } else if (this.previousBlockPosition !== end - 2) {
      this.enqueue(latest, end)
      this.emitted = end + 1
    }
  }

  private enqueue(frame: ReceivedFrame, position: number): void {
    const stdin = this.ffmpeg.stdin
    if (!stdin || stdin.writableEnded || stdin.destroyed) {
      return
    }
    frameBytes(frame)
    this.pending.push({ frame, position })
    this.pendingFrames.set(frame, (this.pendingFrames.get(frame) ?? 0) + 1)
    this.previousBlockPosition = this.lastBlockPosition
    this.lastBlockPosition = position
    this.recordHighWater()
    void this.pump()
  }

  // Pending frames plus the held one. A superseded held frame that never got a
  // span is released when the next arrives, so a check passes the newcomer.
  private retainedBytes(held = this.latest): number {
    let bytes = 0
    for (const frame of this.pendingFrames.keys()) {
      bytes += frameCost(frame)
    }
    if (held && !this.pendingFrames.has(held)) {
      bytes += frameCost(held)
    }
    return bytes
  }

  // A frame is accepted only while its block fits: until the next frame, holds
  // add at most that one block, and the next frame's arrival is checked again.
  private overloadFor(frame: ReceivedFrame): string | undefined {
    const bytes = this.retainedBytes(frame)
    if (bytes > this.limits.maxPendingBytes) {
      return `${formatBytes(bytes)} of frames waiting for the encoder exceeds ${formatBytes(this.limits.maxPendingBytes)}`
    }
    if (this.pending.length >= this.limits.maxPendingBlocks) {
      return `${this.pending.length.toString()} frames waiting for the encoder reached the limit of ${this.limits.maxPendingBlocks.toString()}`
    }
    return undefined
  }

  private overload(detail: string): void {
    const seconds = this.emitted / this.fps
    this.incomplete = `The encoder fell behind the screencast (${detail}); capture stopped after ${seconds.toFixed(1)}s to bound memory.`
    this.stopCapturing()
    // Chrome need not keep encoding frames nobody will write.
    void this.session.send('Page.stopScreencast').catch(() => undefined)
  }

  private recordHighWater(): void {
    this.highWaterBlocks = Math.max(this.highWaterBlocks, this.pending.length)
    this.highWaterBytes = Math.max(this.highWaterBytes, this.retainedBytes())
    this.recordLag()
  }

  // Measured to the end of the timeline rather than the newest block: a held
  // frame extends the timeline without queueing a block of its own.
  private recordLag(): void {
    const oldest = this.pending[0]
    if (oldest) {
      this.highWaterLag = Math.max(
        this.highWaterLag,
        this.emitted - oldest.position,
      )
    }
  }

  private releasePending(): void {
    this.pending.length = 0
    this.pendingFrames.clear()
    this.latest = undefined
  }

  // Hands queued blocks to FFmpeg in order, one writer at a time, and resolves
  // once nothing is queued. Waits for the input to drain whenever it reports
  // backpressure, and yields between batches of small writes so timers,
  // deadlines and abort still run.
  private pump(): Promise<void> {
    if (!this.draining) {
      this.draining = true
      void this.drainPending()
    }
    if (!this.draining && this.pending.length === 0) {
      return Promise.resolve()
    }
    this.idle ??= Promise.withResolvers<void>()
    return this.idle.promise
  }

  private async drainPending(): Promise<void> {
    // No await between finding the queue empty and clearing the flag: a block
    // queued in the same turn must start a new writer rather than wait.
    try {
      let batch = 0
      let block = this.pending.shift()
      while (block) {
        const stdin = this.ffmpeg.stdin
        if (!stdin || stdin.writableEnded || stdin.destroyed) {
          this.releasePending()
          return
        }
        let accepted = true
        for (const chunk of this.blocks.frame(
          frameBytes(block.frame),
          Math.round((block.position * 1_000) / this.playbackRate),
        )) {
          accepted = stdin.write(chunk) && accepted
        }
        this.releaseBlock(block)
        batch += 1
        if (!accepted) {
          batch = 0
          await this.waitForDrain(stdin)
        } else if (batch >= WRITE_BATCH) {
          batch = 0
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        block = this.pending.shift()
      }
    } finally {
      this.draining = false
      this.idle?.resolve()
      this.idle = undefined
    }
  }

  private releaseBlock(block: PendingBlock): void {
    const references = (this.pendingFrames.get(block.frame) ?? 1) - 1
    if (references > 0) {
      this.pendingFrames.set(block.frame, references)
    } else {
      this.pendingFrames.delete(block.frame)
    }
  }

  private async waitForDrain(
    stdin: NonNullable<ChildProcess['stdin']>,
  ): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    stdin.once('drain', resolve)
    stdin.once('close', resolve)
    try {
      await Promise.race([promise, this.encoder.closed, this.cancelled.promise])
    } finally {
      stdin.off('drain', resolve)
      stdin.off('close', resolve)
    }
  }
}

const formatBytes = (bytes: number): string => {
  const mebibyte = 1024 * 1024
  return bytes >= mebibyte
    ? `${(bytes / mebibyte).toFixed(1)} MiB`
    : `${bytes.toString()} bytes`
}

export const recordScreencast = async (
  page: Page,
  options: ScreencastRecorderOptions,
  dependencies: ScreencastRecorderDependencies = {},
): Promise<ScreencastRecorder> => {
  const clock = dependencies.clock ?? systemClock
  const dimensions = await readNativePixelDimensions(page)
  const canvas = resolveCaptureCanvas(
    dimensions,
    options.maxWidth,
    options.maxHeight,
  )
  const crop = options.crop
    ? toDevicePixelCrop(options.crop, dimensions)
    : undefined
  const ffmpeg = (dependencies.spawnProcess ?? spawnFfmpeg)(
    options.ffmpegPath,
    createFfmpegArguments(options, canvas, crop),
  )
  const encoder = new ScreencastEncoder(ffmpeg, dependencies, true)
  let session: CDPSession | undefined
  let recorder: ScreencastRecorder | undefined
  let abandoned = false
  let timer: NodeJS.Timeout | undefined
  const cancelled = Promise.withResolvers<never>()
  let cancellationError: Error | undefined
  const cancel = (error: Error): void => {
    cancellationError ??= error
    cancelled.reject(cancellationError)
  }
  const onPageClosed = (): void => {
    cancel(new Error('Page closed during screencast startup'))
  }
  const checkStartup = (): void => {
    // Promise.race can prefer a ready success over a failure observed in the
    // same turn. Never advance startup or hand off a known cancelled recorder.
    if (cancellationError) {
      throw cancellationError
    }
    encoder.throwIfFailed()
  }
  const encoderFailed = encoder.failed.then((error) => {
    throw error
  })
  // Observe failures before any asynchronous startup operation can settle.
  const interrupted = Promise.race([encoderFailed, cancelled.promise])
  void interrupted.catch(() => undefined)
  page.once?.('close', onPageClosed)
  try {
    await Promise.race([encoder.spawned, interrupted])
    checkStartup()
    timer = clock.setTimeout(() => {
      cancel(
        new Error(
          `Screencast CDP startup timed out after ${CDP_STARTUP_TIMEOUT_MS}ms`,
        ),
      )
    }, CDP_STARTUP_TIMEOUT_MS)
    timer.unref?.()
    session = await Promise.race([
      page.createCDPSession().then((attached) => {
        // A raced promise still runs. Dispose a late session without starting
        // capture or changing the shared page behind the following test.
        if (abandoned) {
          void attached.detach().catch(() => undefined)
        } else {
          session = attached
        }
        return attached
      }),
      interrupted,
    ])
    checkStartup()
    recorder = new ScreencastRecorder({
      canvas,
      clock,
      encoder,
      ffmpeg,
      fps: options.fps,
      speed: options.speed,
      monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
      ...(dependencies.queueLimits
        ? { queueLimits: dependencies.queueLimits }
        : {}),
      session,
    })
    await Promise.race([
      session.send('Page.startScreencast', {
        format: 'png',
        ...(options.maxWidth === undefined
          ? {}
          : { maxWidth: options.maxWidth }),
        ...(options.maxHeight === undefined
          ? {}
          : { maxHeight: options.maxHeight }),
      }),
      interrupted,
    ])
    checkStartup()
    clock.clearTimeout(timer)
    timer = undefined
    await Promise.race([recorder.waitForFirstFrame(clock), interrupted])
    checkStartup()
    if (recorder.destroyed) {
      throw new Error('Recorder closed during screencast startup')
    }
    encoder.markStarted()
    return recorder
  } catch (error) {
    abandoned = true
    if (recorder) {
      await recorder.abort()
    } else {
      void session?.detach().catch(() => undefined)
      await encoder.abort()
    }
    throw error
  } finally {
    if (timer) {
      clock.clearTimeout(timer)
    }
    page.off?.('close', onPageClosed)
  }
}

export const createFfmpegArguments = (
  options: Pick<ScreencastRecorderOptions, 'format' | 'quality'> &
    Partial<Pick<ScreencastRecorderOptions, 'scale'>>,
  dimensions: Pick<PixelDimensions, 'width' | 'height'>,
  crop: Readonly<CaptureCrop> | undefined,
): string[] => {
  const { width, height } = dimensions
  const filters = [
    `crop='min(${width},iw):min(${height},ih):0:0'`,
    `pad=${width}:${height}:0:0`,
  ]
  // `scale` defaults to 1, which is truthy, so an unconfigured recording would
  // otherwise pay for a full Lanczos resample of every frame to produce the
  // frame it already had. `speed` is applied to the frame timestamps.
  if (crop) {
    filters.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`)
  }
  if (options.scale !== undefined && options.scale !== 1) {
    filters.push(`scale=iw*${options.scale}:-1:flags=lanczos`)
  }
  // RGB input would otherwise select VP9 profile 1 (planar RGB): about 2.5
  // times the size of 4:2:0, and not playable by Safari or hardware decoders.
  filters.push('format=yuv420p')
  return [
    ['-loglevel', 'error'],
    // Frames arrive once each, timestamped on the grid, so the video holds an
    // unchanged page instead of decoding and encoding it at every position.
    // Keep input buffering and probing at their defaults; a tiny probe size or
    // `-avioflags direct` loses the first frames.
    ['-f', 'matroska', '-i', 'pipe:0'],
    ['-an', '-threads', '1', '-b:v', '0'],
    ['-vcodec', 'vp9', '-crf', `${options.quality}`],
    ['-deadline', 'realtime'],
    ['-cpu-used', `${VP9_REALTIME_SPEED}`],
    // WebM keeps frame timestamps by default. MP4 would otherwise repeat each
    // frame onto a constant rate; its `hybrid_fragmented` flag already needs an
    // FFmpeg recent enough to accept `-fps_mode`.
    options.format === 'mp4'
      ? [
          '-fps_mode',
          'passthrough',
          '-movflags',
          'hybrid_fragmented',
          '-f',
          'mp4',
        ]
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
  try {
    if (emulatedViewport) {
      await page.setViewport({ ...emulatedViewport, deviceScaleFactor: 0 })
    }
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
