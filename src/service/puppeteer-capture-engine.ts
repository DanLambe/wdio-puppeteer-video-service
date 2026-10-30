import { finished } from 'node:stream/promises'
import type { Page, Browser as PuppeteerBrowser } from 'puppeteer-core'
import type { Browser } from 'webdriverio'
import type { OutputFormat, ResolvedCaptureOptions } from '../types.js'
import type { ClockBoundary, FileSystemBoundary } from './boundaries.js'
import {
  BROWSER_RENDER_TIMEOUT_MS,
  primeScreencastFrames,
  type StartScreencastOptions,
  waitForBrowserToRender,
} from './capture.js'
import type { CaptureSession, SegmentTabReason } from './capture-session.js'
import {
  ACTIVE_PAGE_POLL_MS,
  ACTIVE_PAGE_TIMEOUT_MS,
  type ActiveSegment,
  RECORDER_STOP_TIMEOUT_MS,
  type ResolvedTranscodeOptions,
  SEGMENT_SWITCH_DELAY_MS,
  WINDOW_SEGMENT_COMMANDS,
  WRITE_STREAM_TIMEOUT_MS,
} from './constants.js'
import type { ServiceLogger } from './logging.js'
import { describeError, isBenignStreamWriteError } from './normalization.js'
import {
  beforeDeadline,
  findActivePage,
  findPageByTargetId,
  PAGE_MARKER_PROPERTY,
} from './page-lookup.js'
import {
  classifySessionProtocol,
  describePuppeteerConnectionFailure,
  type ProtocolBrowser,
  type SessionProtocol,
} from './protocol.js'
import type { ScreencastRecorder } from './screencast-recorder.js'

export interface CaptureSegmentOutput {
  readonly outputFormat: OutputFormat
  readonly outputPath: string
  readonly recordingFormat: OutputFormat
  readonly recordingPath: string
  readonly transcodeEnabled: boolean
}

/** Which tab a segment records, and why it starts there. */
export interface CaptureTarget {
  /** A WebDriver BiDi browsing context; omitted, WDIO's current window. */
  readonly contextId?: string
  readonly reason?: SegmentTabReason
}

export interface CaptureStartOptions {
  readonly createOutput: () => Promise<CaptureSegmentOutput>
  readonly ffmpegPath: string
  readonly target?: CaptureTarget
  readonly transcodeOptions: ResolvedTranscodeOptions
}

export interface CaptureStartResult {
  readonly started: boolean
}

export interface CaptureStopResult {
  /**
   * Why capture was incomplete, when the recorder knows. Reported for a
   * discarded segment too: retention does not make a failed capture healthy.
   */
  readonly incompleteReason?: string
  readonly segment: ActiveSegment | undefined
  readonly streamOk: boolean
}

export interface CaptureWindowOperations {
  runSerialized(task: () => Promise<void>): Promise<void>
  startRecording(reason?: SegmentTabReason): Promise<boolean>
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
  ) => Promise<ScreencastRecorder>
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
  private activePage: Page | undefined
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

  async preparePage(
    target: CaptureTarget = {},
  ): Promise<
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
    const windowHandle =
      target.contextId ??
      (await browser.getWindowHandle().catch(() => undefined))
    const page = await this.findPage(
      browser,
      puppeteerBrowser,
      windowHandle,
      target,
    )
    if (!page) {
      this.log(
        'warn',
        '[WdioPuppeteerVideoService] Could not find puppeteer page match. Recording skipped.',
      )
      return undefined
    }

    // Chrome does not paint a tab that is not in front, headless or not, so
    // the recorded tab is brought forward as WebDriver's switchToWindow does.
    await page.bringToFront().catch(() => undefined)
    return { page, windowHandle }
  }

  /** Whether the page of the attached capture has closed underneath it. */
  get isRecordedPageClosed(): boolean {
    return this.activePage?.isClosed() ?? false
  }

  private async findPage(
    browser: Browser,
    puppeteerBrowser: PuppeteerBrowser,
    windowHandle: string | undefined,
    target: CaptureTarget,
  ): Promise<Page | undefined> {
    // A BiDi window handle is its top-level browsing context, whose id
    // Chromium shares with the CDP target.
    if (browser.isBidi && windowHandle) {
      const page = await findPageByTargetId(puppeteerBrowser, windowHandle, {
        clock: this.clock,
      })
      if (page) {
        return page
      }
      this.log(
        'debug',
        `[WdioPuppeteerVideoService] No page has the target id of browsing context ${windowHandle}; finding it by a marker instead.`,
      )
      // WDIO's current window is never a stand-in for a requested context,
      // so its marker goes into that context.
      if (target.contextId) {
        return this.findContextPage(browser, puppeteerBrowser, target.contextId)
      }
    }
    return this.findSessionPage(browser, puppeteerBrowser)
  }

  private async findContextPage(
    browser: Browser,
    puppeteerBrowser: PuppeteerBrowser,
    contextId: string,
  ): Promise<Page | undefined> {
    const markerId = this.nextPageMarkerId()
    const setMarker = async (value: string | null): Promise<void> => {
      await browser.scriptCallFunction({
        functionDeclaration: `(property, id, value) => {
          if (value === null) {
            if (Reflect.get(globalThis, property) === id) {
              Reflect.deleteProperty(globalThis, property)
            }
            return
          }
          Object.defineProperty(globalThis, property, {
            configurable: true,
            enumerable: false,
            value,
            writable: false,
          })
        }`,
        target: { context: contextId },
        awaitPromise: false,
        arguments: [
          { type: 'string', value: PAGE_MARKER_PROPERTY },
          { type: 'string', value: markerId },
          value === null ? { type: 'null' } : { type: 'string', value },
        ],
      })
    }
    // Marking and the search share one deadline. The marker is removed once
    // it is set and the search is over, however late the browser sets it, and
    // the removal never holds up the command waiting for this page.
    const deadline = this.clock.now() + ACTIVE_PAGE_TIMEOUT_MS
    const marking = setMarker(markerId)
    const searched = Promise.withResolvers<void>()
    void Promise.allSettled([marking, searched.promise])
      .then(async ([marked]) => {
        if (marked.status === 'fulfilled') {
          await setMarker(null)
        }
      })
      .catch(() => undefined)
    try {
      const marked = await beforeDeadline(
        marking.then(() => true),
        this.clock,
        deadline,
      )
      if (!marked) {
        this.log(
          'debug',
          '[WdioPuppeteerVideoService] Marking the browsing context to record timed out.',
        )
        return undefined
      }
      return await findActivePage(puppeteerBrowser, markerId, {
        clock: this.clock,
        timeoutMs: deadline - this.clock.now(),
      })
    } catch (error) {
      this.log(
        'debug',
        `[WdioPuppeteerVideoService] Could not mark the browsing context to record: ${describeError(error)}`,
      )
      return undefined
    } finally {
      searched.resolve()
    }
  }

  /**
   * Waits, before any test runs, for a browser that has just launched to
   * render, so its first recording does not start before anything is drawn.
   * Best effort: a connection or page lookup failure is left for the first
   * recording to report, as it would be without this wait.
   */
  async warmUp(): Promise<void> {
    const browser = this.session.browser
    if (!browser) {
      return
    }
    const puppeteerBrowser = await this.getPuppeteerBrowser(browser, false)
    if (!puppeteerBrowser) {
      return
    }
    const page = await this.findSessionPage(browser, puppeteerBrowser)
    if (!page) {
      return
    }
    await page.bringToFront().catch(() => undefined)
    const rendered = await waitForBrowserToRender(page, this.clock)
    if (rendered === 'timed-out') {
      this.log(
        'warn',
        `[WdioPuppeteerVideoService] Timed out waiting ${String(BROWSER_RENDER_TIMEOUT_MS / 1_000)}s for browser render readiness. First recordings may be empty.`,
      )
    } else if (rendered === 'failed') {
      // A page that closed or a protocol error is not a rendering delay, and
      // the first recording reports it. Leave a trace of the unconfirmed paint.
      this.log(
        'debug',
        '[WdioPuppeteerVideoService] Browser render readiness could not be confirmed: the paint request failed.',
      )
    }
  }

  private async findSessionPage(
    browser: Browser,
    puppeteerBrowser: PuppeteerBrowser,
  ): Promise<Page | undefined> {
    const markerId = this.nextPageMarkerId()
    await this.markPageContext(browser, markerId)
    return findActivePage(puppeteerBrowser, markerId, {
      clock: this.clock,
    }).finally(async () => {
      await this.removePageMarker(browser, markerId)
    })
  }

  private async markPageContext(
    browser: Browser,
    markerId: string,
  ): Promise<void> {
    const mark = async (): Promise<void> => {
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
    }

    try {
      await mark()
    } catch (error) {
      if (
        !/Cannot find context with specified id|Execution context was destroyed/iu.test(
          describeError(error),
        )
      ) {
        throw error
      }
      // WDIO's automatic tab switch can overlap the next navigation. Retry only
      // the marker in its replacement context, once, before allocating media.
      await this.clock.delay(ACTIVE_PAGE_POLL_MS)
      await mark()
    }
  }

  async startCapture(
    options: CaptureStartOptions,
  ): Promise<CaptureStartResult> {
    let pendingRecorder: ScreencastRecorder | undefined
    let pendingSegment: ActiveSegment | undefined
    let pendingRecordingPath: string | undefined
    try {
      const activePage = await this.preparePage(options.target)
      if (!activePage) {
        return { started: false }
      }

      const { page, windowHandle } = activePage
      const output = await options.createOutput()
      pendingRecordingPath = output.recordingPath
      const recorder = await this.startScreencast(page, {
        capture: this.capture,
        clock: this.clock,
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
      if (
        this.capture.framePriming &&
        !(await primeScreencastFrames(page, this.clock, recorder))
      ) {
        this.log(
          'debug',
          '[WdioPuppeteerVideoService] Screencast delivered fewer than two frames after frame priming; the recording may show only its first frame.',
        )
      }

      this.session.attachCapture({
        recorder,
        segment,
        windowHandle,
        ...(options.target?.reason ? { reason: options.target.reason } : {}),
      })
      this.activePage = page
      pendingRecorder = undefined
      pendingSegment = undefined
      pendingRecordingPath = undefined
      return { started: true }
    } catch (error) {
      await this.cleanupPartialCapture(pendingRecorder, pendingSegment)
      if (pendingRecordingPath && !pendingSegment) {
        await this.fileSystem
          .unlink(pendingRecordingPath)
          .catch(() => undefined)
      }
      throw error
    }
  }

  async stopCapture(
    options: Readonly<{ discard?: boolean }> = {},
  ): Promise<CaptureStopResult> {
    const { recorder, segment } = this.session.detachCapture()
    this.activePage = undefined
    if (!recorder) {
      return { segment: undefined, streamOk: false }
    }
    if (options.discard) {
      // Retention already decided this recording is not being kept. Frames are
      // encoded as they are captured, so the encoding already done cannot be
      // reclaimed; stopping gracefully would additionally drain whatever is
      // still queued, flush, and finish writing a file that is deleted moments
      // later. That tail is largest on a host whose encoder has fallen behind.
      await this.discardCapture(recorder, segment)
      this.logQueueStats(recorder)
      // Read after the abort, which reports an encoder exit that preceded it.
      const incompleteReason = recorder.incompleteReason
      return {
        ...(incompleteReason ? { incompleteReason } : {}),
        segment: undefined,
        streamOk: true,
      }
    }
    const recorderStopped = await this.stopRecorder(recorder)
    this.logQueueStats(recorder)
    if (!recorderStopped && !segment.writeStream.destroyed) {
      // Destroying a pipe's source does not end its destination. Flush bytes
      // already accepted by the file without waiting for an impossible EOF.
      segment.writeStream.end()
    }
    // A stop that missed its deadline was already reported and aborted; only
    // a completed stop has an encoder result of its own to check.
    const encoderOk = recorderStopped && this.checkEncoderResult(recorder)

    try {
      const streamFinished = await this.waitForWriteStream(segment)
      const streamOk = encoderOk && streamFinished
      if (!streamOk) {
        this.markSegmentAsUnclean(segment)
      }
      const incompleteReason = recorder.incompleteReason
      return {
        ...(incompleteReason ? { incompleteReason } : {}),
        segment,
        streamOk,
      }
    } finally {
      recorder.off('error', segment.onRecorderError)
      segment.writeStream.off('error', segment.onWriteStreamError)
    }
  }

  async resetRecording(): Promise<void> {
    const { recorder, segment } = this.session.detachCapture()
    this.activePage = undefined
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
    reportFailure = true,
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
      const protocol = classifySessionProtocol(
        browser.capabilities,
        true,
        browser.isBidi,
      )
      this.session.setConnection(puppeteerBrowser, protocol)
      this.onProtocolChanged(protocol)
      this.log(
        'info',
        `[WdioPuppeteerVideoService] Session protocol classified as ${protocol}: WDIO controls the browser through ${protocol === 'bidi+cdp' ? 'WebDriver BiDi' : 'classic WebDriver'}, while Puppeteer capture attaches through CDP.`,
      )
      return puppeteerBrowser
    } catch (error) {
      this.resetConnection()
      if (reportFailure) {
        this.onConnectionFailure(
          describePuppeteerConnectionFailure(browser, error),
        )
      }
      return undefined
    }
  }

  private createActiveSegment(
    recorder: ScreencastRecorder,
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
    recorder: ScreencastRecorder | undefined,
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

  // Like `cleanupPartialCapture`, but never waits for a graceful stop: the
  // encoder's remaining output is unwanted, so it is terminated outright.
  private async discardCapture(
    recorder: ScreencastRecorder,
    segment: ActiveSegment,
  ): Promise<void> {
    await recorder.abort()
    if (!recorder.destroyed) {
      recorder.destroy()
    }
    recorder.off('error', segment.onRecorderError)
    segment.writeStream.off('error', segment.onWriteStreamError)
    if (!segment.writeStream.destroyed) {
      segment.writeStream.destroy()
    }
    await segment.writeStreamDone.catch(() => undefined)
    await this.fileSystem.unlink(segment.recordingPath).catch(() => undefined)
  }

  private async stopRecorder(recorder: ScreencastRecorder): Promise<boolean> {
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
      return true
    } catch (error) {
      // An expected deadline, not a crash: a stack trace only adds noise.
      this.log(
        'warn',
        `[WdioPuppeteerVideoService] Error stopping recorder: ${describeError(error)}`,
      )
      await recorder.abort()
      return false
    } finally {
      this.clock.clearTimeout(timeout)
    }
  }

  private logQueueStats(recorder: ScreencastRecorder): void {
    const stats = recorder.queueStats
    this.log(
      'debug',
      `[WdioPuppeteerVideoService] Encoder queue high-water: ${stats.highWaterBlocks.toString()} frames, ${(stats.highWaterBytes / (1024 * 1024)).toFixed(1)} MiB, ${stats.highWaterLagSeconds.toFixed(2)}s behind capture.`,
    )
  }

  // A file that finished writing is not a complete recording if the encoder
  // failed: keep its bytes as an unclean segment instead of transcoding them.
  private checkEncoderResult(recorder: ScreencastRecorder): boolean {
    if (recorder.incompleteReason) {
      // Frames already accepted were still encoded, so the segment is kept as
      // unclean media rather than processed as a complete recording. The
      // stop result carries the reason into the segment's one warning.
      return false
    }
    if (recorder.frameCount === 0) {
      this.log(
        'warn',
        '[WdioPuppeteerVideoService] The screencast delivered no frames before recording stopped, so the recording is empty.',
      )
      return false
    }
    const { code, diagnostic, signal } = recorder.ffmpegResult
    if (code === 0 && signal === null) {
      return true
    }
    const exit = signal
      ? `was terminated by ${signal}`
      : `exited with code ${String(code)}`
    const details = diagnostic ? `: ${diagnostic}` : '.'
    this.log(
      'warn',
      `[WdioPuppeteerVideoService] FFmpeg ${exit} while recording${details}`,
    )
    return false
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
    // WDIO may already have switched and resumed capture while closing a tab.
    if (this.session.hasCapture) {
      return
    }
    const handle = await browser.getWindowHandle().catch(() => undefined)
    const handles = await browser.getWindowHandles().catch((): string[] => [])
    this.session.setWindowHandle(undefined)
    if (!handle || !handles.includes(handle)) {
      return
    }
    this.session.advanceSegment()
    await this.clock.delay(SEGMENT_SWITCH_DELAY_MS)
    await operations.startRecording('tab-closed')
  }

  private async switchWindowSegment(
    browser: Browser,
    operations: CaptureWindowOperations,
  ): Promise<void> {
    const handle = await browser.getWindowHandle().catch(() => undefined)
    if (
      !handle ||
      (this.session.currentWindowHandle === handle && this.session.hasCapture)
    ) {
      return
    }
    await operations.stopRecording()
    this.session.advanceSegment()
    await operations.startRecording('switch-to-window')
  }

  /** WDIO's current window, which in a BiDi session is its context id. */
  async currentWindowHandle(): Promise<string | undefined> {
    return this.session.browser?.getWindowHandle().catch(() => undefined)
  }
}
