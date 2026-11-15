import type { Browser as PuppeteerBrowser } from 'puppeteer-core'
import type { Browser } from 'webdriverio'
import type { ActiveSegment } from './constants.js'
import type { SessionProtocol } from './protocol.js'
import type { ScreencastRecorder } from './screencast-recorder.js'

export type DetachedCapture =
  | Readonly<{
      recorder: ScreencastRecorder
      segment: ActiveSegment
    }>
  | Readonly<{
      recorder: undefined
      segment: undefined
    }>

/** Why a segment started on its tab. */
export type SegmentTabReason =
  | 'start'
  | 'command'
  | 'switch-to-window'
  | 'tab-closed'
  /** The browser refused to close the tab, so its recording continues. */
  | 'close-failed'
  /** The browser rejected a switch away, so recording returns to its window. */
  | 'switch-failed'

/** The tab or window a segment recorded, numbered in order of first use. */
export interface SegmentTab {
  readonly contextId: string
  readonly ordinal: number
  readonly reason: SegmentTabReason
}

/**
 * A segment whose capture has stopped, held without post-processing until the
 * recording's outcome is known.
 */
export interface HeldSegment {
  /** Whether the encoder finished the file as a whole recording. */
  readonly clean: boolean
  readonly part: number
  readonly segment: ActiveSegment
  readonly tab?: SegmentTab
}

export interface AttachCaptureOptions {
  readonly recorder: ScreencastRecorder
  readonly segment: ActiveSegment
  readonly windowHandle: string | undefined
  readonly reason?: SegmentTabReason
}

export class CaptureSession {
  private wdioBrowser: Browser | undefined
  private connectedPuppeteerBrowser: PuppeteerBrowser | undefined
  private captureRecorder: ScreencastRecorder | undefined
  private captureSegment: ActiveSegment | undefined
  private segmentNumber = 0
  private recordingSlug = ''
  private readonly retainedPaths = new Set<string>()
  private readonly stoppedSegments: HeldSegment[] = []
  private activeWindowHandle: string | undefined
  private readonly tabOrdinals = new Map<string, number>()
  private readonly tabsBySegment = new Map<number, SegmentTab>()
  private sessionProtocol: SessionProtocol = 'unsupported'

  get browser(): Browser | undefined {
    return this.wdioBrowser
  }

  get puppeteerBrowser(): PuppeteerBrowser | undefined {
    return this.connectedPuppeteerBrowser
  }

  get recorder(): ScreencastRecorder | undefined {
    return this.captureRecorder
  }

  get activeSegment(): ActiveSegment | undefined {
    return this.captureSegment
  }

  get currentSegment(): number {
    return this.segmentNumber
  }

  get currentTestSlug(): string {
    return this.recordingSlug
  }

  get recordedPaths(): readonly string[] {
    return Object.freeze([...this.retainedPaths])
  }

  /** Stopped segments not yet finalized or discarded, in part order. */
  get heldSegments(): readonly HeldSegment[] {
    return Object.freeze([...this.stoppedSegments])
  }

  /**
   * Every file the recording has on disk: its recorded paths, and the files of
   * the segments still held.
   */
  get filePaths(): readonly string[] {
    return Object.freeze([
      ...new Set([
        ...this.retainedPaths,
        ...this.stoppedSegments.map((held) => held.segment.recordingPath),
      ]),
    ])
  }

  get currentWindowHandle(): string | undefined {
    return this.activeWindowHandle
  }

  /** Whether a capture was attached to the current segment number. */
  get currentSegmentStarted(): boolean {
    return this.tabsBySegment.has(this.segmentNumber)
  }

  /** Tabs of the current recording, keyed by segment number. */
  get segmentTabs(): ReadonlyMap<number, SegmentTab> {
    return new Map(this.tabsBySegment)
  }

  get protocol(): SessionProtocol {
    return this.sessionProtocol
  }

  get hasCapture(): boolean {
    return !!this.captureRecorder || !!this.captureSegment
  }

  get isRecordingActive(): boolean {
    return !!this.recordingSlug || this.hasCapture
  }

  setBrowser(browser: Browser): void {
    this.wdioBrowser = browser
  }

  clearBrowser(): void {
    this.wdioBrowser = undefined
    this.invalidateConnection()
  }

  setConnection(browser: PuppeteerBrowser, protocol: SessionProtocol): void {
    this.connectedPuppeteerBrowser = browser
    this.sessionProtocol = protocol
  }

  invalidateConnection(): void {
    this.connectedPuppeteerBrowser = undefined
    this.sessionProtocol = 'unsupported'
  }

  beginRecording(slug: string): void {
    if (this.hasCapture) {
      throw new Error('Cannot begin a recording while capture is attached')
    }
    this.recordingSlug = slug
    this.segmentNumber = 1
    this.activeWindowHandle = undefined
    this.retainedPaths.clear()
    this.stoppedSegments.length = 0
    this.clearTabs()
  }

  attachCapture(options: AttachCaptureOptions): void {
    if (!this.recordingSlug || this.segmentNumber < 1) {
      throw new Error('Cannot attach capture before recording is initialized')
    }
    if (this.hasCapture) {
      throw new Error('Cannot attach more than one capture segment')
    }
    this.captureRecorder = options.recorder
    this.captureSegment = options.segment
    this.activeWindowHandle = options.windowHandle
    if (options.windowHandle) {
      this.recordSegmentTab(options.windowHandle, options.reason)
    }
  }

  detachCapture(): DetachedCapture {
    const recorder = this.captureRecorder
    const segment = this.captureSegment
    this.captureRecorder = undefined
    this.captureSegment = undefined
    if (recorder && segment) {
      return Object.freeze({ recorder, segment })
    }
    return Object.freeze({ recorder: undefined, segment: undefined })
  }

  advanceSegment(): number {
    if (!this.recordingSlug) {
      throw new Error('Cannot advance a segment without an active recording')
    }
    this.segmentNumber += 1
    return this.segmentNumber
  }

  setWindowHandle(windowHandle: string | undefined): void {
    this.activeWindowHandle = windowHandle
  }

  addRecordedPath(filePath: string): void {
    this.retainedPaths.add(filePath)
  }

  deleteRecordedPath(filePath: string): void {
    this.retainedPaths.delete(filePath)
  }

  clearRecordedPaths(): void {
    this.retainedPaths.clear()
  }

  /** Holds a segment stopped as the current part, with that part's tab. */
  holdSegment(segment: ActiveSegment, clean: boolean): HeldSegment {
    if (!this.recordingSlug) {
      throw new Error('Cannot hold a segment without an active recording')
    }
    const tab = this.tabsBySegment.get(this.segmentNumber)
    const held: HeldSegment = Object.freeze({
      clean,
      part: this.segmentNumber,
      segment,
      ...(tab ? { tab } : {}),
    })
    // Parts are numbered as they start and stop one at a time, so the order
    // they stop in is part order.
    this.stoppedSegments.push(held)
    return held
  }

  /** Stops holding a segment once it has been finalized. */
  releaseHeldSegment(held: HeldSegment): void {
    const index = this.stoppedSegments.indexOf(held)
    if (index >= 0) {
      this.stoppedSegments.splice(index, 1)
    }
  }

  clearHeldSegments(): void {
    this.stoppedSegments.length = 0
  }

  resetRecording(): DetachedCapture {
    const detached = this.detachCapture()
    this.segmentNumber = 0
    this.recordingSlug = ''
    this.activeWindowHandle = undefined
    this.retainedPaths.clear()
    this.stoppedSegments.length = 0
    this.clearTabs()
    return detached
  }

  private recordSegmentTab(
    contextId: string,
    reason: SegmentTabReason | undefined,
  ): void {
    let ordinal = this.tabOrdinals.get(contextId)
    if (ordinal === undefined) {
      ordinal = this.tabOrdinals.size + 1
      this.tabOrdinals.set(contextId, ordinal)
    }
    this.tabsBySegment.set(this.segmentNumber, {
      contextId,
      ordinal,
      reason: reason ?? (this.tabsBySegment.size === 0 ? 'start' : 'command'),
    })
  }

  private clearTabs(): void {
    this.tabOrdinals.clear()
    this.tabsBySegment.clear()
  }
}
