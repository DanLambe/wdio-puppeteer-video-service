import type {
  Browser as PuppeteerBrowser,
  ScreenRecorder,
} from 'puppeteer-core'
import type { Browser } from 'webdriverio'
import type { ActiveSegment } from './constants.js'
import type { SessionProtocol } from './protocol.js'

export type DetachedCapture =
  | Readonly<{
      recorder: ScreenRecorder
      segment: ActiveSegment
    }>
  | Readonly<{
      recorder: undefined
      segment: undefined
    }>

export interface AttachCaptureOptions {
  readonly recorder: ScreenRecorder
  readonly segment: ActiveSegment
  readonly windowHandle: string | undefined
}

export class CaptureSession {
  private wdioBrowser: Browser | undefined
  private connectedPuppeteerBrowser: PuppeteerBrowser | undefined
  private captureRecorder: ScreenRecorder | undefined
  private captureSegment: ActiveSegment | undefined
  private segmentNumber = 0
  private recordingSlug = ''
  private readonly retainedPaths = new Set<string>()
  private activeWindowHandle: string | undefined
  private sessionProtocol: SessionProtocol = 'unsupported'

  get browser(): Browser | undefined {
    return this.wdioBrowser
  }

  get puppeteerBrowser(): PuppeteerBrowser | undefined {
    return this.connectedPuppeteerBrowser
  }

  get recorder(): ScreenRecorder | undefined {
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

  get currentWindowHandle(): string | undefined {
    return this.activeWindowHandle
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

  resetRecording(): DetachedCapture {
    const detached = this.detachCapture()
    this.segmentNumber = 0
    this.recordingSlug = ''
    this.activeWindowHandle = undefined
    this.retainedPaths.clear()
    return detached
  }
}
