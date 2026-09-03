import { finished } from 'node:stream/promises'
import type {
  Page,
  Browser as PuppeteerBrowser,
  ScreenRecorder,
} from 'puppeteer-core'
import type { Browser } from 'webdriverio'
import type { OutputFormat, ResolvedCaptureOptions } from '../types.js'
import type { ClockBoundary, FileSystemBoundary } from './boundaries.js'
import {
  primeScreencastFrames,
  resolveCaptureDimensions,
  type StartScreencastOptions,
} from './capture.js'
import type { CaptureSession } from './capture-session.js'
import {
  type ActiveSegment,
  RECORDER_STOP_TIMEOUT_MS,
  type ResolvedTranscodeOptions,
  SEGMENT_SWITCH_DELAY_MS,
  WINDOW_SEGMENT_COMMANDS,
  WRITE_STREAM_TIMEOUT_MS,
} from './constants.js'
import type { ServiceLogger } from './logging.js'
import { describeError, isBenignStreamWriteError } from './normalization.js'
import { findActivePage, PAGE_MARKER_PROPERTY } from './page-lookup.js'
import {
  classifySessionProtocol,
  describePuppeteerConnectionFailure,
  type ProtocolBrowser,
  type SessionProtocol,
} from './protocol.js'

export interface CaptureSegmentOutput {
  readonly outputFormat: OutputFormat
  readonly outputPath: string
  readonly recordingFormat: OutputFormat
  readonly recordingPath: string
  readonly transcodeEnabled: boolean
}

export interface CaptureStartOptions {
  readonly createOutput: () => Promise<CaptureSegmentOutput>
  readonly ffmpegPath: string
  readonly transcodeOptions: ResolvedTranscodeOptions
}

export type CaptureStartResult =
  | { readonly started: false }
  | {
      readonly dimensions: { readonly height: number; readonly width: number }
      readonly started: true
    }
  | {
      readonly dimensions: undefined
      readonly started: true
    }

export interface CaptureStopResult {
  readonly segment: ActiveSegment | undefined
  readonly streamOk: boolean
}

export interface CaptureWindowOperations {
  runSerialized(task: () => Promise<void>): Promise<void>
  startRecording(): Promise<boolean>
  stopRecording(): Promise<void>
}

export interface PuppeteerCaptureEngineOptions {
  readonly capture: ResolvedCaptureOptions
  readonly clock: ClockBoundary
  readonly connectPuppeteer: (
    browser: ProtocolBrowser,
    timeoutMs: number,
  ) => Promise<PuppeteerBrowser>
  readonly fileSystem: FileSystemBoundary
  readonly getSessionToken: () => string
  readonly log: ServiceLogger
  readonly onConnectionFailure: (reason: string) => void
  readonly onProtocolChanged: (protocol: SessionProtocol) => void
  readonly session: CaptureSession
  readonly startScreencast: (
    page: Page,
    options: StartScreencastOptions,
  ) => Promise<ScreenRecorder>
  readonly uuid: () => string
}

export class PuppeteerCaptureEngine {
  private readonly capture: ResolvedCaptureOptions
  private readonly clock: ClockBoundary
  private readonly connectPuppeteer: PuppeteerCaptureEngineOptions['connectPuppeteer']
  private readonly fileSystem: FileSystemBoundary
  private readonly getSessionToken: () => string
  private readonly log: ServiceLogger
  private readonly onConnectionFailure: (reason: string) => void
  private readonly onProtocolChanged: (protocol: SessionProtocol) => void
  private markerCounter = 0
  private readonly session: CaptureSession
  private readonly startScreencast: PuppeteerCaptureEngineOptions['startScreencast']
  private readonly uuid: () => string

  constructor(options: PuppeteerCaptureEngineOptions) {
    this.capture = options.capture
    this.clock = options.clock
    this.connectPuppeteer = options.connectPuppeteer
    this.fileSystem = options.fileSystem
    this.getSessionToken = options.getSessionToken
    this.log = options.log
    this.onConnectionFailure = options.onConnectionFailure
    this.onProtocolChanged = options.onProtocolChanged
    this.session = options.session
    this.startScreencast = options.startScreencast
    this.uuid = options.uuid
  }

  async preparePage(): Promise<
    | { readonly page: Page; readonly windowHandle: string | undefined }
    | undefined
  > {
    const browser = this.session.browser
    if (!browser) {
      return undefined
    }
    const puppeteerBrowser = await this.getPuppeteerBrowser(browser)
    if (!puppeteerBrowser) {
      return undefined
    }
    const windowHandle = await browser.getWindowHandle().catch(() => undefined)
    const markerId = this.nextPageMarkerId()

    await browser.execute(
      (property: string, id: string) => {
        Object.defineProperty(globalThis, property, {
          configurable: true,
          enumerable: false,
          value: id,
          writable: false,
        })
      },
      PAGE_MARKER_PROPERTY,
      markerId,
    )

    const page = await findActivePage(puppeteerBrowser, markerId, {
      clock: this.clock,
    }).finally(async () => {
      await this.removePageMarker(browser, markerId)
    })
    if (!page) {
      this.log(
        'warn',
        '[WdioPuppeteerVideoService] Could not find puppeteer page match. Recording skipped.',
      )
      return undefined
    }

    await page.bringToFront().catch(() => undefined)
    return { page, windowHandle }
  }

  async startCapture(
    options: CaptureStartOptions,
  ): Promise<CaptureStartResult> {
    let pendingRecorder: ScreenRecorder | undefined
    let pendingSegment: ActiveSegment | undefined
    let pendingRecordingPath: string | undefined
    try {
      const activePage = await this.preparePage()
      if (!activePage) {
        return { started: false }
      }

      const { page, windowHandle } = activePage
      const dimensions = await resolveCaptureDimensions(page, this.capture)
      const output = await options.createOutput()
      pendingRecordingPath = output.recordingPath
      const recorder = await this.startScreencast(page, {
        capture: this.capture,
        ffmpegPath: options.ffmpegPath,
        format: output.recordingFormat,
        onViewportRestoreError: (error) => {
          this.log(
            'warn',
            `[WdioPuppeteerVideoService] Failed to restore the browser viewport after capture initialization: ${describeError(error)}`,
          )
        },
      })
      pendingRecorder = recorder
      const segment = this.createActiveSegment(
        recorder,
        output,
        options.transcodeOptions,
      )
      pendingSegment = segment
      recorder.pipe(segment.writeStream)
      if (this.capture.framePriming) {
        await primeScreencastFrames(page, this.clock)
      }

      this.session.attachCapture({
        dimensions,
        recorder,
        segment,
        windowHandle,
      })
      pendingRecorder = undefined
      pendingSegment = undefined
      pendingRecordingPath = undefined
      return dimensions
        ? { dimensions, started: true }
        : { dimensions: undefined, started: true }
    } catch (error) {
      await this.cleanupPartialCapture(pendingRecorder, pendingSegment)
      if (pendingRecordingPath) {
        await this.fileSystem
          .unlink(pendingRecordingPath)
          .catch(() => undefined)
      }
      throw error
    }
  }

  async stopCapture(): Promise<CaptureStopResult> {
    const { recorder, segment } = this.session.detachCapture()
    if (!recorder) {
      return { segment: undefined, streamOk: false }
    }
    await this.stopRecorder(recorder)

    try {
      const streamOk = await this.waitForWriteStream(segment)
      if (!streamOk) {
        this.markSegmentAsUnclean(segment)
      }
      return { segment, streamOk }
    } finally {
      recorder.off('error', segment.onRecorderError)
      segment.writeStream.off('error', segment.onWriteStreamError)
    }
  }

  async resetRecording(): Promise<void> {
    const { recorder, segment } = this.session.detachCapture()
    await this.cleanupPartialCapture(recorder, segment)
    this.session.resetRecording()
  }

  resetConnection(): void {
    this.session.invalidateConnection()
    this.onProtocolChanged('unsupported')
  }

  async beforeWindowCommand(
    commandName: string,
    operations: CaptureWindowOperations,
  ): Promise<void> {
    if (commandName !== 'closeWindow') {
      return
    }
    await operations.runSerialized(operations.stopRecording)
  }

  async afterWindowCommand(
    commandName: string,
    operations: CaptureWindowOperations,
  ): Promise<void> {
    if (!WINDOW_SEGMENT_COMMANDS.has(commandName)) {
      return
    }
    await operations.runSerialized(async () => {
      const browser = this.session.browser
      if (!browser) {
        return
      }
      if (commandName === 'closeWindow') {
        await this.startAfterWindowClose(browser, operations)
        return
      }
      await this.switchWindowSegment(browser, operations)
    })
  }

  private async getPuppeteerBrowser(
    browser: Browser,
  ): Promise<PuppeteerBrowser | undefined> {
    const current = this.session.puppeteerBrowser
    if (current && current.connected !== false) {
      return current
    }
    try {
      const puppeteerBrowser = await this.connectPuppeteer(
        browser,
        this.capture.connectionTimeoutMs,
      )
      const protocol = classifySessionProtocol(browser.capabilities, true)
      this.session.setConnection(puppeteerBrowser, protocol)
      this.onProtocolChanged(protocol)
      this.log(
        'info',
        `[WdioPuppeteerVideoService] Session protocol classified as ${protocol}: WDIO controls the browser through ${protocol === 'bidi+cdp' ? 'WebDriver BiDi' : 'classic WebDriver'}, while Puppeteer capture attaches through CDP.`,
      )
      return puppeteerBrowser
    } catch (error) {
      this.resetConnection()
      this.onConnectionFailure(
        describePuppeteerConnectionFailure(browser, error),
      )
      return undefined
    }
  }

  private createActiveSegment(
    recorder: ScreenRecorder,
    output: CaptureSegmentOutput,
    transcodeOptions: ResolvedTranscodeOptions,
  ): ActiveSegment {
    const writeStream = this.fileSystem.createWriteStream(
      output.recordingPath,
      'r+',
    )
    const writeStreamDone = finished(writeStream)
    let segment: ActiveSegment | undefined
    let recorderErrorLogged = false
    const onWriteStreamError = (error: NodeJS.ErrnoException) => {
      if (segment?.writeStreamErrored) {
        return
      }
      const writeErrorMessage = describeError(error)
      if (segment) {
        segment.writeStreamErrored = true
        segment.writeStreamErrorMessage = writeErrorMessage
      }
      const benignError = isBenignStreamWriteError(error)
      this.log(
        benignError ? 'debug' : 'warn',
        benignError
          ? `[WdioPuppeteerVideoService] Recording stream closed while recorder was still flushing (${writeErrorMessage}).`
          : `[WdioPuppeteerVideoService] Recording stream error: ${writeErrorMessage}`,
      )
    }
    const onRecorderError = (error: unknown) => {
      if (recorderErrorLogged) {
        return
      }
      recorderErrorLogged = true
      this.log(
        'warn',
        `[WdioPuppeteerVideoService] Recorder stream error: ${describeError(error)}`,
      )
    }
    writeStream.on('error', onWriteStreamError)
    recorder.on('error', onRecorderError)
    segment = {
      outputFormat: output.outputFormat,
      outputPath: output.outputPath,
      recordingFormat: output.recordingFormat,
      recordingPath: output.recordingPath,
      transcode: output.transcodeEnabled,
      transcodeOptions,
      writeStream,
      writeStreamDone,
      writeStreamErrored: false,
      onWriteStreamError,
      onRecorderError,
    }
    return segment
  }

  private async cleanupPartialCapture(
    recorder: ScreenRecorder | undefined,
    segment: ActiveSegment | undefined,
  ): Promise<void> {
    if (recorder) {
      await this.stopRecorder(recorder)
      if (!recorder.destroyed) {
        recorder.destroy()
      }
    }
    if (!segment) {
      return
    }
    recorder?.off('error', segment.onRecorderError)
    segment.writeStream.off('error', segment.onWriteStreamError)
    if (!segment.writeStream.destroyed) {
      segment.writeStream.destroy()
    }
    await segment.writeStreamDone.catch(() => undefined)
    await this.fileSystem.unlink(segment.recordingPath).catch(() => undefined)
  }

  private async stopRecorder(recorder: ScreenRecorder): Promise<void> {
    const { promise: timeoutTask, reject: rejectTimeout } =
      Promise.withResolvers<never>()
    const timeout = this.clock.setTimeout(() => {
      rejectTimeout(
        new Error(
          `Recorder stop timed out after ${RECORDER_STOP_TIMEOUT_MS.toString()}ms`,
        ),
      )
    }, RECORDER_STOP_TIMEOUT_MS)
    timeout.unref()
    try {
      await Promise.race([recorder.stop(), timeoutTask])
    } catch (error) {
      this.log(
        'warn',
        '[WdioPuppeteerVideoService] Error stopping recorder:',
        error,
      )
      if (!recorder.destroyed) {
        recorder.destroy()
      }
    } finally {
      this.clock.clearTimeout(timeout)
    }
  }

  private async waitForWriteStream(segment: ActiveSegment): Promise<boolean> {
    if (segment.writeStreamErrored) {
      await segment.writeStreamDone.catch(() => undefined)
      return false
    }
    const { promise: timeoutTask, resolve: resolveTimeout } =
      Promise.withResolvers<false>()
    const timeout = this.clock.setTimeout(() => {
      resolveTimeout(false)
    }, WRITE_STREAM_TIMEOUT_MS)
    timeout.unref()
    let streamOk: boolean
    try {
      streamOk = await Promise.race([
        segment.writeStreamDone.then(() => true).catch(() => false),
        timeoutTask,
      ])
    } finally {
      this.clock.clearTimeout(timeout)
    }
    if (streamOk) {
      return true
    }
    const timeoutMessage = `Timed out waiting for recording stream to finish: ${segment.recordingPath}`
    this.log('warn', timeoutMessage)
    segment.writeStreamErrored = true
    segment.writeStreamErrorMessage = timeoutMessage
    if (!segment.writeStream.destroyed) {
      segment.writeStream.destroy(new Error(timeoutMessage))
    }
    await segment.writeStreamDone.catch(() => undefined)
    return false
  }

  private markSegmentAsUnclean(segment: ActiveSegment): void {
    segment.transcode = false
    segment.outputPath = segment.recordingPath
    segment.outputFormat = segment.recordingFormat
  }

  private async removePageMarker(
    browser: Browser,
    markerId: string,
  ): Promise<void> {
    await browser
      .execute(
        (property: string, id: string) => {
          if (Reflect.get(globalThis, property) === id) {
            Reflect.deleteProperty(globalThis, property)
          }
        },
        PAGE_MARKER_PROPERTY,
        markerId,
      )
      .catch(() => undefined)
  }

  private nextPageMarkerId(): string {
    this.markerCounter += 1
    const sessionToken = this.getSessionToken() || 'pending'
    return `wdio-video-${sessionToken}-${this.markerCounter.toString(36)}-${this.uuid()}`
  }

  private async startAfterWindowClose(
    browser: Browser,
    operations: CaptureWindowOperations,
  ): Promise<void> {
    const handle = await browser.getWindowHandle().catch(() => undefined)
    if (!handle) {
      this.session.setWindowHandle(undefined)
      return
    }
    this.session.advanceSegment()
    await this.clock.delay(SEGMENT_SWITCH_DELAY_MS)
    await operations.startRecording()
  }

  private async switchWindowSegment(
    browser: Browser,
    operations: CaptureWindowOperations,
  ): Promise<void> {
    const handle = await browser.getWindowHandle().catch(() => undefined)
    if (!handle || this.session.currentWindowHandle === handle) {
      return
    }
    await operations.stopRecording()
    this.session.advanceSegment()
    await operations.startRecording()
  }
}
