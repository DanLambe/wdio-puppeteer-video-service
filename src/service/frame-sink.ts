import type { ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import type { Writable } from 'node:stream'
import { type ClockBoundary, systemClock } from './boundaries.js'
import type { ScreencastEncodeSettings } from './screencast-arguments.js'
import {
  type FfmpegResult,
  ScreencastEncoder,
  type ScreencastEncoderDependencies,
} from './screencast-encoder.js'

/**
 * Where the recorder's Matroska stream goes. A sink accepts bytes until it is
 * ended, aborted, or fails on its own; `failure` then says why it stopped
 * taking them before it was ended.
 */
export interface FrameSink {
  readonly kind: 'encoder' | 'spool'
  /** Resolves once the sink can take no more bytes and has closed. */
  readonly closed: Promise<void>
  /** Why the sink stopped taking bytes on its own before it was ended. */
  readonly failure: string | undefined
  /** Resolves once the sink is ready for bytes. */
  readonly ready: Promise<void>
  /** Resolves with the error that ended the sink, if one does. */
  readonly failed: Promise<Error>
  readonly writable: boolean
  /** Stops taking bytes at once, discarding any not yet delivered. */
  abort(): Promise<void>
  /** Delivers every byte written, then closes. Never rejects. */
  end(): Promise<void>
  /** Startup handed the sink to a recorder. */
  markStarted(): void
  throwIfFailed(): void
  /** Resolves once buffered bytes drain, or the sink closes. */
  waitForDrain(): Promise<void>
  /** Returns `false` when the caller should wait for drain. */
  write(chunk: Buffer): boolean
}

/** A live encoder: FFmpeg's standard input, owning its process. */
export class EncoderSink implements FrameSink {
  readonly kind = 'encoder'
  private readonly child: ChildProcess
  private readonly encoder: ScreencastEncoder
  private ending = false
  private aborting = false

  constructor(
    child: ChildProcess,
    dependencies: ScreencastEncoderDependencies = {},
    starting = false,
  ) {
    this.child = child
    this.encoder = new ScreencastEncoder(child, dependencies, starting)
  }

  get closed(): Promise<void> {
    return this.encoder.closed
  }

  get failed(): Promise<Error> {
    return this.encoder.failed
  }

  get ready(): Promise<void> {
    return this.encoder.spawned
  }

  /** How FFmpeg exited, once it has, and the end of its error output. */
  get result(): FfmpegResult {
    return this.encoder.result
  }

  // Only `end` finishes FFmpeg's input, so an encoder that exits before then
  // has not encoded the whole recording, whatever its exit code. `abort`
  // terminates it on purpose.
  get failure(): string | undefined {
    const exited =
      this.child.exitCode !== null || this.child.signalCode !== null
    if (this.ending || this.aborting || !exited) {
      return undefined
    }
    const { code, diagnostic, signal } = this.encoder.result
    const exit = signal
      ? `was terminated by ${signal}`
      : `exited with code ${String(code)}`
    const detail = diagnostic ? `: ${diagnostic}` : '.'
    return `FFmpeg ${exit} before the recording was stopped${detail}`
  }

  get writable(): boolean {
    const stdin = this.child.stdin
    return Boolean(stdin && !stdin.writableEnded && !stdin.destroyed)
  }

  write(chunk: Buffer): boolean {
    const stdin = this.child.stdin
    if (!stdin || !this.writable) {
      return false
    }
    return stdin.write(chunk)
  }

  async waitForDrain(): Promise<void> {
    const stdin = this.child.stdin
    if (!stdin) {
      return
    }
    await waitForStreamDrain(stdin, this.encoder.closed)
  }

  async end(): Promise<void> {
    this.ending = true
    this.child.stdin?.end()
    await this.encoder.closed
  }

  abort(): Promise<void> {
    this.aborting = true
    return this.encoder.abort()
  }

  markStarted(): void {
    this.encoder.markStarted()
  }

  throwIfFailed(): void {
    this.encoder.throwIfFailed()
  }
}

/** A spool file: the stream a live encoder would be given, for a later encode. */
export interface ScreencastSpool {
  readonly path: string
  readonly settings: ScreencastEncodeSettings
}

/** The file a spool is written through; `fs.WriteStream` in production. */
export type SpoolFileStream = Writable & {
  /** Bytes the file system has accepted. */
  readonly bytesWritten: number
  /** `true` until the file is open. */
  readonly pending?: boolean
}

export type OpenSpoolFile = (path: string) => SpoolFileStream

// A new file only: a spool never replaces anything already at its path.
const openSpoolFile: OpenSpoolFile = (path) =>
  createWriteStream(path, { flags: 'wx' })

// Bounds how long an abort waits for the file to close. `closed` still
// reports the real close, which a caller awaits before deleting the file.
const SPOOL_CLOSE_TIMEOUT_MS = 1_000

export interface SpoolSinkDependencies {
  readonly clock?: ClockBoundary
  readonly openFile?: OpenSpoolFile
}

/**
 * Writes the recorder's stream to a new file. The file is never deleted
 * here: once `end` or `abort` has closed it, that is the caller's decision.
 */
export class SpoolSink implements FrameSink {
  readonly kind = 'spool'
  readonly closed: Promise<void>
  readonly failed: Promise<Error>
  readonly ready: Promise<void>
  readonly spool: ScreencastSpool
  private readonly stream: SpoolFileStream
  private readonly clock: ClockBoundary
  private readonly failedState = Promise.withResolvers<Error>()
  private error: Error | undefined
  private aborting: Promise<void> | undefined
  private accepted = 0
  private flushWaiters: Array<() => void> = []
  private opened = false
  private closedState = false

  constructor(
    spool: ScreencastSpool,
    dependencies: SpoolSinkDependencies = {},
  ) {
    this.spool = spool
    this.clock = dependencies.clock ?? systemClock
    this.failed = this.failedState.promise
    const stream = (dependencies.openFile ?? openSpoolFile)(spool.path)
    this.stream = stream
    const closed = Promise.withResolvers<void>()
    this.closed = closed.promise
    const ready = Promise.withResolvers<void>()
    this.ready = ready.promise
    stream.on('error', this.onError)
    // A file stream opens even when it was destroyed while opening, so this
    // also records an open that completes after an abort.
    stream.once('open', () => {
      this.opened = true
    })
    stream.once('close', () => {
      this.closedState = true
      closed.resolve()
      this.onFlushed()
    })
    if (stream.pending === true) {
      stream.once('ready', () => {
        ready.resolve()
      })
    } else {
      ready.resolve()
    }
  }

  /** Bytes the file system has accepted. */
  get bytesWritten(): number {
    return this.stream.bytesWritten
  }

  /**
   * Whether this sink's exclusive open created its file. Only then is the file
   * this recording's: an open refused with `EEXIST` found someone else's.
   */
  get created(): boolean {
    return this.opened
  }

  /** Whether the file has closed, so nothing holds it open any more. */
  get isClosed(): boolean {
    return this.closedState
  }

  /**
   * Bytes `write` has taken: those the file system has written and those it
   * has not yet. This is what the spool will hold once it is flushed.
   */
  get bytesAccepted(): number {
    return this.accepted
  }

  /** Bytes accepted by `write` that the file system has not yet taken. */
  get bytesBuffered(): number {
    return this.stream.writableLength
  }

  get failure(): string | undefined {
    return this.error?.message
  }

  get writable(): boolean {
    return this.stream.writable
  }

  write(chunk: Buffer): boolean {
    if (!this.stream.writable) {
      return false
    }
    this.accepted += chunk.length
    return this.stream.write(chunk, this.onFlushed)
  }

  /**
   * Resolves once the file system has taken another write, or the file has
   * closed. A caller that finds bytes still buffered waits here for them.
   */
  waitForFlush(): Promise<void> {
    if (this.closedState) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.flushWaiters.push(resolve)
    })
  }

  async waitForDrain(): Promise<void> {
    await waitForStreamDrain(this.stream, this.closed)
  }

  async end(): Promise<void> {
    if (this.stream.writable) {
      this.stream.end()
    }
    await this.closed
  }

  abort(): Promise<void> {
    this.aborting ??= this.close()
    return this.aborting
  }

  markStarted(): void {
    // A file has no startup state to leave: aborting it is the same either way.
  }

  throwIfFailed(): void {
    if (this.error) {
      throw this.error
    }
  }

  private async close(): Promise<void> {
    this.stream.destroy()
    const expired = Promise.withResolvers<void>()
    const timer = this.clock.setTimeout(expired.resolve, SPOOL_CLOSE_TIMEOUT_MS)
    timer.unref?.()
    try {
      await Promise.race([this.closed, expired.promise])
    } finally {
      this.clock.clearTimeout(timer)
    }
  }

  // Every write is told when it has been taken, so a waiter never misses one
  // that was already in flight.
  private readonly onFlushed = (): void => {
    const waiters = this.flushWaiters
    this.flushWaiters = []
    for (const resolve of waiters) {
      resolve()
    }
  }

  private readonly onError = (error: Error): void => {
    // Writes refused after an abort are not a failure of the spool.
    if (this.aborting !== undefined || this.error) {
      return
    }
    this.error = new Error(
      `The frame spool could not be written: ${error.message}`,
      { cause: error },
    )
    this.failedState.resolve(this.error)
  }
}

/** One sink of either kind, as the recorder holds it. */
export type ScreencastSink = EncoderSink | SpoolSink

const waitForStreamDrain = async (
  stream: Writable,
  closed: Promise<void>,
): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  stream.once('drain', resolve)
  stream.once('close', resolve)
  try {
    await Promise.race([promise, closed])
  } finally {
    stream.off('drain', resolve)
    stream.off('close', resolve)
  }
}
