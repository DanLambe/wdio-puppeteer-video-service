import path from 'node:path'
import type { ResolvedWdioPuppeteerVideoServiceOptions } from '../types.js'
import {
  buildFullSessionIdToken,
  buildSessionIdToken,
  buildTestSlugFromMetadata,
  reserveUniqueSlug,
  type SlugMetadata,
} from '../video-name-utils.js'
import { reserveArtifactPath } from './artifact-integrity.js'
import type {
  CaptureSession,
  SegmentTab,
  SegmentTabReason,
} from './capture-session.js'
import type { ActiveSegment, OutputFormat } from './constants.js'
import type { ContextFollowerTarget, FollowReason } from './context-follower.js'
import type { FfmpegRuntime } from './ffmpeg-runtime.js'
import { runInternal } from './internal-operation.js'
import type { ServiceLogger } from './logging.js'
import type { ManifestWorkerRecorder } from './manifest-runtime.js'
import * as artifactPaths from './paths.js'
import type {
  CaptureSegmentOutput,
  CaptureTarget,
  CaptureWindowOperations,
  PuppeteerCaptureEngine,
} from './puppeteer-capture-engine.js'
import { RecordingLifecycle } from './recording-lifecycle.js'
import type { RecordingMediaCoordinator } from './recording-media-coordinator.js'
import type { RecordingSlotScheduler } from './recording-slots.js'
import type { RecordingMediaFinalization } from './worker-recording-coordinator.js'

// A tab that fails to start recording is retried on later commands, a few
// times, rather than for every command the test sends it. The count is of
// consecutive failures: a start clears it, and so does a new recording or a
// reset. Switching to another tab and back does not.
const MAX_TAB_START_ATTEMPTS = 2

type CaptureEnginePort = Pick<
  PuppeteerCaptureEngine,
  | 'afterWindowCommand'
  | 'beforeWindowCommand'
  | 'currentWindowHandle'
  | 'isRecordedPageClosed'
  | 'resetRecording'
  | 'startCapture'
  | 'stopCapture'
>

type FfmpegRuntimePort = Pick<
  FfmpegRuntime,
  'ensureReady' | 'resolvePath' | 'shouldTranscode'
>

type RecordingSlotPort = Pick<
  RecordingSlotScheduler,
  'acquire' | 'ownsGlobalRecordingSlot' | 'ownsRecordingSlot' | 'release'
>

export interface RecordingControllerOptions {
  readonly captureEngine: CaptureEnginePort
  readonly captureSession: CaptureSession
  readonly ffmpegRuntime: FfmpegRuntimePort
  readonly getManifestRecorder: () => ManifestWorkerRecorder | undefined
  readonly log: ServiceLogger
  readonly maxSlugLength: number
  readonly media: RecordingMediaCoordinator
  readonly options: ResolvedWdioPuppeteerVideoServiceOptions
  readonly recordingSlotScheduler: RecordingSlotPort
}

/** Owns capture lifecycle, serialization, naming, and recording-slot invariants. */
export class RecordingController implements ContextFollowerTarget {
  private readonly captureEngine: CaptureEnginePort
  private readonly captureSession: CaptureSession
  private captureFailure: string | undefined
  private closingContextId: string | undefined
  private readonly failedStarts = new Map<string, number>()
  // A tab a switch selected but could not record. It becomes a capture gap
  // unless the browser rejects that switch, which leaves the test where it was.
  private unconfirmedGap: string | undefined
  private readonly ffmpegRuntime: FfmpegRuntimePort
  private readonly getManifestRecorder: () => ManifestWorkerRecorder | undefined
  private readonly lifecycle = new RecordingLifecycle()
  private readonly log: ServiceLogger
  private readonly maxSlugLength: number
  private readonly media: RecordingMediaCoordinator
  private readonly options: ResolvedWdioPuppeteerVideoServiceOptions
  private recordingTask: Promise<void> = Promise.resolve()
  private readonly recordingSlotScheduler: RecordingSlotPort
  private sessionFullToken = ''
  private sessionToken = ''
  private readonly slugUsageCount = new Map<string, number>()
  private warnedAboutMp4Compatibility = false

  constructor(options: RecordingControllerOptions) {
    this.captureEngine = options.captureEngine
    this.captureSession = options.captureSession
    this.ffmpegRuntime = options.ffmpegRuntime
    this.getManifestRecorder = options.getManifestRecorder
    this.log = options.log
    this.maxSlugLength = options.maxSlugLength
    this.media = options.media
    this.options = options.options
    this.recordingSlotScheduler = options.recordingSlotScheduler
  }

  get sessionIdToken(): string {
    return this.sessionToken
  }

  get ownsResources(): boolean {
    return (
      this.captureSession.isRecordingActive ||
      this.recordingSlotScheduler.ownsRecordingSlot ||
      this.recordingSlotScheduler.ownsGlobalRecordingSlot
    )
  }

  setSessionId(sessionId: string): void {
    this.sessionToken = buildSessionIdToken(sessionId)
    this.sessionFullToken = buildFullSessionIdToken(sessionId)
  }

  async beforeWindowCommand(commandName: string): Promise<void> {
    if (!this.shouldSegmentWindowChanges()) {
      return
    }
    await this.captureEngine.beforeWindowCommand(
      commandName,
      this.captureWindowOperations(),
    )
  }

  async afterWindowCommand(commandName: string): Promise<void> {
    if (!this.shouldSegmentWindowChanges()) {
      return
    }
    await this.captureEngine.afterWindowCommand(
      commandName,
      this.captureWindowOperations(),
    )
  }

  // WebDriver BiDi tab following keeps three facts apart: the selected tab
  // (`captureSession.currentWindowHandle`), whether a capture is attached for
  // it (`captureSession.hasCapture`), and a close the test has requested but
  // the browser has not yet confirmed (`closingContextId`).
  //
  // A driven tab that cannot be recorded is a gap: the recording is reported
  // as incomplete, and stays so after later segments start. Another tab is
  // never filmed in its place.

  get recordedContextId(): string | undefined {
    return this.captureSession.currentWindowHandle
  }

  get hasActiveCapture(): boolean {
    return this.captureSession.hasCapture
  }

  /** Moves recording to the tab a WebDriver BiDi test is now driving. */
  async followContext(contextId: string, reason: FollowReason): Promise<void> {
    if (!this.shouldSegmentWindowChanges()) {
      return
    }
    await this.runSerialized(async () => {
      const selected = this.captureSession.currentWindowHandle
      if (reason === 'switch-failed' && this.unconfirmedGap === selected) {
        this.unconfirmedGap = undefined
      }
      this.confirmGap()
      const exhausted =
        (this.failedStarts.get(contextId) ?? 0) >= MAX_TAB_START_ATTEMPTS
      // Read when the task runs: an earlier queued switch may already have
      // moved recording here.
      if (selected === contextId) {
        if (
          this.captureSession.hasCapture ||
          this.closingContextId === contextId ||
          exhausted
        ) {
          return
        }
      } else {
        await this.stopRecording()
        this.closingContextId = undefined
        if (exhausted) {
          // The test drives this tab now, but it cannot be recorded.
          this.selectUnrecordedTab(contextId, reason)
          return
        }
      }
      await this.recordTab(contextId, reason)
    })
  }

  /** Ends the recorded tab's segment before the test closes that tab. */
  async stopClosingContext(contextId: string): Promise<void> {
    if (!this.shouldSegmentWindowChanges()) {
      return
    }
    await this.runSerialized(async () => {
      this.confirmGap()
      if (this.captureSession.currentWindowHandle !== contextId) {
        return
      }
      await this.stopRecording()
      this.closingContextId = contextId
    })
  }

  /** The browser refused to close the recorded tab; record it again. */
  async recoverFailedClose(contextId: string): Promise<void> {
    if (!this.shouldSegmentWindowChanges()) {
      return
    }
    await this.runSerialized(async () => {
      if (
        this.closingContextId !== contextId ||
        this.captureSession.currentWindowHandle !== contextId
      ) {
        return
      }
      this.closingContextId = undefined
      await this.recordTab(contextId, 'close-failed')
    })
  }

  /** Continues on WDIO's current tab once the recorded one has closed. */
  async resumeAfterClose(): Promise<void> {
    if (!this.shouldSegmentWindowChanges()) {
      return
    }
    await this.runSerialized(async () => {
      this.confirmGap()
      const recorded = this.captureSession.currentWindowHandle
      const closed =
        (recorded !== undefined && this.closingContextId === recorded) ||
        this.captureEngine.isRecordedPageClosed
      if (!closed) {
        return
      }
      if (this.captureSession.hasCapture) {
        await this.stopRecording()
      }
      this.closingContextId = undefined
      const next = await this.captureEngine.currentWindowHandle()
      // A closed current window has no successor until WDIO switches to one;
      // that switch, or the next command, selects the tab instead.
      if (!next || next === recorded) {
        return
      }
      await this.recordTab(next, 'tab-closed')
    })
  }

  /** Starts a segment on a tab; failed starts are retried a bounded number of times. */
  private async recordTab(
    contextId: string,
    reason: SegmentTabReason,
  ): Promise<void> {
    if (this.captureSession.currentSegmentStarted) {
      this.captureSession.advanceSegment()
    }
    this.captureSession.setWindowHandle(contextId)
    let started = false
    try {
      started = await this.startRecording({ contextId, reason })
    } finally {
      // A start that throws failed too; its error still propagates.
      this.countTabStart(contextId, reason, started)
    }
  }

  private countTabStart(
    contextId: string,
    reason: SegmentTabReason,
    started: boolean,
  ): void {
    if (started) {
      this.failedStarts.delete(contextId)
      return
    }
    this.failedStarts.set(
      contextId,
      (this.failedStarts.get(contextId) ?? 0) + 1,
    )
    this.noteTabGap(contextId, reason)
  }

  /** Selects a tab whose recording cannot start, without recording it. */
  private selectUnrecordedTab(
    contextId: string,
    reason: SegmentTabReason,
  ): void {
    if (this.captureSession.currentSegmentStarted) {
      this.captureSession.advanceSegment()
    }
    this.captureSession.setWindowHandle(contextId)
    this.noteTabGap(contextId, reason)
  }

  private noteTabGap(contextId: string, reason: SegmentTabReason): void {
    // A switch may still be rejected, in which case the test never left.
    if (reason === 'switch-to-window') {
      this.unconfirmedGap = contextId
      return
    }
    this.reportTabGap(contextId)
  }

  /** A switch that selected an unrecorded tab was not rejected. */
  private confirmGap(): void {
    if (this.unconfirmedGap) {
      this.reportTabGap(this.unconfirmedGap)
      this.unconfirmedGap = undefined
    }
  }

  private reportTabGap(contextId: string): void {
    this.reportCaptureFailure(
      `Recording could not start on the tab the test is driving (${contextId}); the recording is incomplete.`,
    )
  }

  async startForMetadata(
    metadata: Readonly<SlugMetadata>,
    _retryCount: number,
  ): Promise<boolean> {
    if (this.captureSession.currentTestSlug) {
      return true
    }

    this.log(
      'debug',
      `[WdioPuppeteerVideoService] Starting test recording: ${metadata.testNameToken}`,
    )
    const baseSlug = buildTestSlugFromMetadata(metadata, {
      maxSlugLength: this.maxSlugLength,
      fileNameStyle: this.options.artifacts.naming.style,
      fileNameOverflowStrategy: this.options.artifacts.naming.overflow,
      sessionIdToken: this.sessionToken,
      sessionIdFullToken: this.sessionFullToken,
    })
    this.captureSession.beginRecording(
      reserveUniqueSlug(baseSlug, this.maxSlugLength, this.slugUsageCount),
    )
    this.closingContextId = undefined
    this.failedStarts.clear()
    this.unconfirmedGap = undefined
    return this.startRecording()
  }

  async finalizeMedia(
    passed: boolean,
    keepArtifacts: boolean,
  ): Promise<RecordingMediaFinalization> {
    if (!this.captureSession.currentTestSlug) {
      return { deferred: false, paths: [] }
    }

    const deferredTaskCount = this.media.pendingTaskCount
    let tabs: ReadonlyMap<number, SegmentTab> | undefined
    this.confirmGap()
    await this.lifecycle.finalize({
      stopRecording: async () => {
        await this.stopRecording({ keepArtifacts })
      },
      processArtifacts: async () => {
        // Every segment is stopped and no merge has run yet.
        tabs = this.readRetainedSegmentTabs()
        this.log(
          'debug',
          `[WdioPuppeteerVideoService] Finished test recording (passed=${passed}, keepArtifacts=${keepArtifacts}).`,
        )
        if (!keepArtifacts) {
          await this.media.deleteRecordedSegments()
        }
        if (this.captureFailure) {
          // A window change may have stopped the failed segment earlier. Keep
          // retained bytes, but never merge or process them as healthy media.
          this.media.dropTasksForPaths(this.captureSession.recordedPaths)
          return
        }
        if (!keepArtifacts || !this.options.processing.merge.enabled) {
          return
        }
        if (this.media.shouldDefer) {
          this.media.queueDeferredMerge()
          return
        }
        await this.media.mergeCurrentSegments()
      },
    })

    return {
      ...(this.captureFailure ? { captureFailure: this.captureFailure } : {}),
      deferred: this.media.pendingTaskCount > deferredTaskCount,
      paths: this.captureSession.recordedPaths,
      ...(tabs?.size ? { tabs } : {}),
    }
  }

  /** Tabs of the segments whose files were kept, keyed by part number. */
  private readRetainedSegmentTabs(): ReadonlyMap<number, SegmentTab> {
    const tabs = this.captureSession.segmentTabs
    const retained = new Map<number, SegmentTab>()
    for (const segmentPath of artifactPaths.collectCurrentTestSegmentPaths(
      this.captureSession.currentTestSlug,
      this.captureSession.recordedPaths,
    )) {
      const part = artifactPaths.extractPartNumber(segmentPath)
      const tab = tabs.get(part)
      if (tab) {
        retained.set(part, tab)
      }
    }
    return retained
  }

  async stopRecording(
    options: Readonly<{ keepArtifacts?: boolean }> = {},
  ): Promise<void> {
    let activeSegment: ActiveSegment | undefined
    let streamOk = false
    let incompleteReason: string | undefined
    let recordingSlotReleased = false
    const releaseRecordingSlot = async (): Promise<void> => {
      if (recordingSlotReleased) {
        return
      }
      recordingSlotReleased = true
      await this.recordingSlotScheduler.release()
    }
    const hadWorkAtInvocation = this.captureSession.hasCapture

    await this.lifecycle.stop({
      hasWork: () => this.captureSession.hasCapture,
      stopCapture: async () => {
        const stoppedCapture = await this.captureEngine.stopCapture({
          discard: options.keepArtifacts === false,
        })
        activeSegment = stoppedCapture.segment
        streamOk = stoppedCapture.streamOk
        incompleteReason = stoppedCapture.incompleteReason
      },
      processCapture: async () => {
        try {
          if (!activeSegment) {
            // Retention already deleted the media, but capture had failed
            // before then: the entry and failure policy must still say so.
            if (incompleteReason) {
              this.reportCaptureFailure(
                `Discarded recording was incomplete (${incompleteReason})`,
              )
            }
            return
          }
          if (!streamOk) {
            const reason = incompleteReason ? ` (${incompleteReason})` : ''
            this.reportCaptureFailure(
              `Recording stream did not finish cleanly for: ${activeSegment.recordingPath}${reason}`,
            )
          }
          await releaseRecordingSlot()
          await this.media.finalizeSegment(activeSegment, {
            keepArtifacts: options.keepArtifacts ?? true,
          })
          this.log(
            'debug',
            `[WdioPuppeteerVideoService] Finalized segment ${this.captureSession.currentSegment} (${activeSegment.outputPath})`,
          )
        } finally {
          await releaseRecordingSlot()
        }
      },
    })

    if (!hadWorkAtInvocation && this.ownsRecordingSlot) {
      await this.recordingSlotScheduler.release()
    }
  }

  async reset(): Promise<void> {
    await this.lifecycle.reset(async () => {
      this.captureFailure = undefined
      this.closingContextId = undefined
      this.failedStarts.clear()
      this.unconfirmedGap = undefined
      await this.captureEngine.resetRecording()
      await this.recordingSlotScheduler.release()
    })
  }

  async runSerialized(task: () => Promise<void>): Promise<void> {
    const wrappedTask = async (): Promise<void> => {
      try {
        // Commands this task sends must not re-enter the service's command
        // hooks: queued behind this task, they would wait for it forever.
        await runInternal(task)
      } catch (error) {
        this.log(
          'error',
          '[WdioPuppeteerVideoService] Recording task failed:',
          error,
        )
        if (this.options.failurePolicy === 'error') {
          throw error
        }
      }
    }

    this.recordingTask = this.recordingTask.then(wrappedTask, wrappedTask)
    await this.recordingTask
  }

  private reportCaptureFailure(message: string): void {
    this.captureFailure ??= message
    this.log('warn', `[WdioPuppeteerVideoService] ${message}`)
  }

  private get ownsRecordingSlot(): boolean {
    return (
      this.recordingSlotScheduler.ownsRecordingSlot ||
      this.recordingSlotScheduler.ownsGlobalRecordingSlot
    )
  }

  private shouldSegmentWindowChanges(): boolean {
    return (
      !!this.captureSession.currentTestSlug &&
      this.options.recording.windowChanges === 'segment'
    )
  }

  private captureWindowOperations(): CaptureWindowOperations {
    return {
      runSerialized: (task: () => Promise<void>) => this.runSerialized(task),
      startRecording: (reason?: SegmentTabReason) =>
        this.startRecording(reason ? { reason } : undefined),
      stopRecording: () => this.stopRecording(),
    }
  }

  private async startRecording(target?: CaptureTarget): Promise<boolean> {
    if (
      !this.captureSession.browser ||
      !this.captureSession.currentTestSlug ||
      this.captureSession.recorder
    ) {
      return false
    }
    return this.lifecycle.start(async () =>
      this.startRecordingOperation(target),
    )
  }

  private async startRecordingOperation(
    target: CaptureTarget | undefined,
  ): Promise<boolean> {
    if (!this.captureSession.browser || !this.captureSession.currentTestSlug) {
      return false
    }
    if (!(await this.ffmpegRuntime.ensureReady())) {
      return false
    }
    const acquiredRecordingSlot = await this.acquireRecordingSlotForStart()
    if (!acquiredRecordingSlot) {
      return false
    }

    try {
      const result = await this.captureEngine.startCapture({
        createOutput: async () =>
          this.reserveRecordingOutput(this.createRecordingOutput()),
        ffmpegPath: this.ffmpegRuntime.resolvePath(),
        ...(target ? { target } : {}),
        transcodeOptions: this.options.processing.transcode,
      })
      if (!result.started) {
        return false
      }
      this.log(
        'debug',
        `[WdioPuppeteerVideoService] Recording segment ${this.captureSession.currentSegment} to ${this.captureSession.activeSegment?.outputPath ?? 'unknown output'}`,
      )
      this.getManifestRecorder()?.markCaptureStarted()
      return true
    } catch (error) {
      this.log(
        'error',
        '[WdioPuppeteerVideoService] Failed to start recording:',
        error,
      )
      if (this.options.failurePolicy === 'error') {
        throw error
      }
      return false
    } finally {
      if (acquiredRecordingSlot && !this.captureSession.recorder) {
        await this.recordingSlotScheduler.release()
      }
    }
  }

  private async acquireRecordingSlotForStart(): Promise<boolean> {
    if (await this.recordingSlotScheduler.acquire()) {
      return true
    }
    const timeoutSuffix =
      this.options.concurrency.startMode === 'fast-fail'
        ? ` within ${this.options.concurrency.startTimeoutMs.toString()}ms`
        : ''
    this.log(
      'warn',
      `[WdioPuppeteerVideoService] Recording slot acquisition failed${timeoutSuffix}. Recording skipped for this segment.`,
    )
    return false
  }

  private createRecordingOutput(): CaptureSegmentOutput {
    const outputFormat: OutputFormat = this.options.processing.format
    const transcodeEnabled = this.ffmpegRuntime.shouldTranscode(outputFormat)
    if (
      outputFormat === 'mp4' &&
      !transcodeEnabled &&
      !this.warnedAboutMp4Compatibility
    ) {
      this.warnedAboutMp4Compatibility = true
      this.log(
        'warn',
        '[WdioPuppeteerVideoService] `processing.format: mp4` without `processing.transcode.enabled` can produce VP9-in-MP4 artifacts that may not play in all players.',
      )
    }
    const recordingFormat: OutputFormat = transcodeEnabled
      ? 'webm'
      : outputFormat
    return {
      outputFormat,
      outputPath: artifactPaths.getSegmentPath(
        this.options.outputDir,
        this.captureSession.currentTestSlug,
        this.captureSession.currentSegment,
        outputFormat,
      ),
      recordingFormat,
      recordingPath: artifactPaths.getSegmentPath(
        this.options.outputDir,
        this.captureSession.currentTestSlug,
        this.captureSession.currentSegment,
        recordingFormat,
      ),
      transcodeEnabled,
    }
  }

  private async reserveRecordingOutput(
    output: CaptureSegmentOutput,
  ): Promise<CaptureSegmentOutput> {
    const recordingPath = await reserveArtifactPath(output.recordingPath)
    return {
      ...output,
      recordingPath,
      outputPath: output.transcodeEnabled
        ? replaceFileExtension(recordingPath, output.outputFormat)
        : recordingPath,
    }
  }
}

const replaceFileExtension = (
  filePath: string,
  format: OutputFormat,
): string => {
  const parsed = path.parse(filePath)
  return path.join(parsed.dir, `${parsed.name}.${format}`)
}
