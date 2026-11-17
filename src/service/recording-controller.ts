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
import { type DiskSpaceBoundary, nodeDiskSpace } from './boundaries.js'
import {
  type CaptureSession,
  type HeldSegment,
  isSpooledSegment,
  type SegmentTab,
  type SegmentTabReason,
} from './capture-session.js'
import type { OutputFormat } from './constants.js'
import type { ContextFollowerTarget, FollowReason } from './context-follower.js'
import type { DeferredEncoder, UnencodedSpool } from './deferred-encode.js'
import type { FfmpegRuntime } from './ffmpeg-runtime.js'
import { runInternal } from './internal-operation.js'
import type { ServiceLogger } from './logging.js'
import type { ManifestWorkerRecorder } from './manifest-runtime.js'
import * as artifactPaths from './paths.js'
import type {
  CaptureSegmentOutput,
  CaptureStopResult,
  CaptureTarget,
  CaptureWindowOperations,
  PuppeteerCaptureEngine,
} from './puppeteer-capture-engine.js'
import { RecordingLifecycle } from './recording-lifecycle.js'
import type { RecordingMediaCoordinator } from './recording-media-coordinator.js'
import { selectCaptureMode } from './recording-policy.js'
import type { RecordingSlotScheduler } from './recording-slots.js'
import {
  DEFAULT_SPOOL_LIMITS,
  SpoolBudget,
  type SpoolLimits,
} from './spool-budget.js'
import { formatSpoolFileName } from './spool-name.js'
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
  | 'discardSpool'
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

/** Where a worker writes the spools of deferred segments, and who encodes them. */
export interface SpoolStorage {
  /** This run's spool directory, `<outputDir>/.wdio-video-spool/<runId>`. */
  readonly directory: string
  /** Reads the spool volume's free space; the system's by default. */
  readonly diskSpace?: DiskSpaceBoundary
  readonly encoder: Pick<DeferredEncoder, 'encodeAll' | 'preserveFrames'>
  /** What one recording may spool; `DEFAULT_SPOOL_LIMITS` by default. */
  readonly limits?: SpoolLimits
  readonly uuid: () => string
}

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
  /** Without it, every segment is encoded live. */
  readonly spoolStorage?: SpoolStorage
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
  private recordingRetryCount = 0
  private recordingTask: Promise<void> = Promise.resolve()
  private readonly recordingSlotScheduler: RecordingSlotPort
  private spoolBudget: SpoolBudget | undefined
  private sessionFullToken = ''
  private sessionToken = ''
  private readonly slugUsageCount = new Map<string, number>()
  private readonly spoolStorage: SpoolStorage | undefined
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
    this.spoolStorage = options.spoolStorage
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
    retryCount: number,
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
    this.recordingRetryCount = retryCount
    this.spoolBudget = this.createSpoolBudget()
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
    let processingFailure: { readonly error: unknown } | undefined
    this.confirmGap()
    await this.lifecycle.finalize({
      stopRecording: async () => {
        await this.stopRecording({ keepArtifacts })
      },
      processArtifacts: async () => {
        // The outcome is known: a kept recording's segments are processed now,
        // a discarded one's are deleted below without any.
        if (keepArtifacts) {
          // Every spool is encoded first, within its own budget; transcodes
          // and the merge follow under their usual rules.
          await this.encodeHeldSpools()
          processingFailure = await this.finalizeHeldSegmentsReportingFailure()
        }
        if (processingFailure) {
          // The files kept so far are reported as they are: never merged, and
          // never processed again.
          this.media.dropTasksForPaths(this.captureSession.filePaths)
          return
        }
        // Every segment is finalized and no merge has run yet.
        tabs = this.readRetainedSegmentTabs(this.captureSession.recordedPaths)
        this.log(
          'debug',
          `[WdioPuppeteerVideoService] Finished test recording (passed=${passed}, keepArtifacts=${keepArtifacts}).`,
        )
        if (!keepArtifacts) {
          await this.discardHeldSpools()
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

    let paths = this.captureSession.recordedPaths
    if (processingFailure) {
      // Finalized parts and the held parts after the failure, while their tab
      // history is still known.
      paths = await this.media.findExisting(this.captureSession.filePaths)
      tabs = this.readRetainedSegmentTabs(paths)
    }
    return {
      ...(this.captureFailure ? { captureFailure: this.captureFailure } : {}),
      deferred: this.media.pendingTaskCount > deferredTaskCount,
      paths,
      ...(processingFailure ? { processingFailure } : {}),
      ...(tabs?.size ? { tabs } : {}),
    }
  }

  /** Deletes the spools of a recording that is not being kept, unencoded. */
  private async discardHeldSpools(): Promise<void> {
    for (const held of this.captureSession.heldSegments) {
      if (held.spool) {
        await this.captureEngine.discardSpool(held.spool)
        this.captureSession.releaseHeldSegment(held)
      }
    }
  }

  /** Tabs of the segments whose files are listed, keyed by part number. */
  private readRetainedSegmentTabs(
    paths: readonly string[],
  ): ReadonlyMap<number, SegmentTab> {
    const tabs = this.captureSession.segmentTabs
    const retained = new Map<number, SegmentTab>()
    for (const segmentPath of artifactPaths.collectCurrentTestSegmentPaths(
      this.captureSession.currentTestSlug,
      paths,
    )) {
      const part = artifactPaths.extractPartNumber(segmentPath)
      const tab = tabs.get(part)
      if (tab) {
        retained.set(part, tab)
      }
    }
    return retained
  }

  /**
   * Ends a recording whose outcome will never be known, as when the worker
   * ends or the session reloads mid-recording: its media is kept.
   */
  async finalizeWithoutOutcome(): Promise<void> {
    await this.stopRecording()
    await this.encodeHeldSpools()
    await this.finalizeHeldSegments()
  }

  /**
   * Encodes the held spools of a kept recording, in part order. An encoded
   * segment takes its spool's place; one that cannot be encoded keeps its
   * frames, any output FFmpeg wrote as unclean media, and makes the recording
   * incomplete. No spool is held afterwards, so nothing encodes it again.
   */
  private async encodeHeldSpools(): Promise<void> {
    const held = this.captureSession.heldSegments
    const spooled = held.filter(isSpooledSegment)
    const storage = this.spoolStorage
    if (!storage || spooled.length === 0) {
      return
    }
    const capturedSeconds = held.reduce(
      (total, segment) => total + segment.capturedSeconds,
      0,
    )
    for (const { held: segment, outcome } of await storage.encoder.encodeAll(
      spooled,
      capturedSeconds,
    )) {
      if (outcome.kind === 'encoded') {
        this.captureSession.replaceHeldSegment(segment, outcome.segment)
        continue
      }
      this.reportCaptureFailure(outcome.failure)
      if (outcome.partial) {
        this.captureSession.replaceHeldSegment(segment, outcome.partial)
      } else {
        this.captureSession.releaseHeldSegment(segment)
      }
    }
  }

  /**
   * Finalizes the held segments of a kept recording. A processing error is
   * returned, not thrown, so the recording can still be reported with the
   * files it has before the error is applied.
   */
  private async finalizeHeldSegmentsReportingFailure(): Promise<
    { readonly error: unknown } | undefined
  > {
    try {
      await this.finalizeHeldSegments()
      return undefined
    } catch (error) {
      return { error }
    }
  }

  /**
   * Finalizes each held segment in part order. A segment stays held until its
   * finalization returns, so one that throws is still among the recording's
   * files, with every segment after it.
   */
  private async finalizeHeldSegments(): Promise<void> {
    for (const held of this.captureSession.heldSegments) {
      await this.media.finalizeSegment(held.segment)
      this.captureSession.releaseHeldSegment(held)
      this.log(
        'debug',
        `[WdioPuppeteerVideoService] Finalized segment ${held.part.toString()} (${held.segment.outputPath})`,
      )
    }
  }

  /**
   * Stops the current capture. A stopped segment is held, unprocessed, until
   * the recording's outcome is known; a discarded capture leaves none.
   */
  async stopRecording(
    options: Readonly<{ keepArtifacts?: boolean }> = {},
  ): Promise<void> {
    let stopped: CaptureStopResult = NOTHING_STOPPED
    const hadWorkAtInvocation = this.captureSession.hasCapture

    await this.lifecycle.stop({
      hasWork: () => this.captureSession.hasCapture,
      stopCapture: async () => {
        stopped = await this.captureEngine.stopCapture({
          discard: options.keepArtifacts === false,
        })
      },
      processCapture: async () => {
        try {
          this.holdStoppedSegment(stopped)
        } finally {
          await this.recordingSlotScheduler.release()
        }
      },
    })

    if (!hadWorkAtInvocation && this.ownsRecordingSlot) {
      await this.recordingSlotScheduler.release()
    }
  }

  /** Holds what a stop left, and reports a capture that stopped short. */
  private holdStoppedSegment(stopped: CaptureStopResult): void {
    const { incompleteReason, segment, streamOk } = stopped
    if (!segment) {
      // Retention already deleted the media, but capture had failed before
      // then: the entry and failure policy must still say so.
      if (incompleteReason) {
        this.reportCaptureFailure(
          `Discarded recording was incomplete (${incompleteReason})`,
        )
      }
      return
    }
    const file = stopped.spool?.path ?? segment.recordingPath
    if (!streamOk) {
      const reason = incompleteReason ? ` (${incompleteReason})` : ''
      this.reportCaptureFailure(
        `Recording stream did not finish cleanly for: ${file}${reason}`,
      )
    }
    const held = this.captureSession.holdSegment(segment, {
      capturedSeconds: stopped.capturedSeconds,
      clean: streamOk,
      ...(incompleteReason === undefined ? {} : { incompleteReason }),
      ...(stopped.spool ? { spool: stopped.spool } : {}),
    })
    this.log(
      'debug',
      `[WdioPuppeteerVideoService] Stopped segment ${held.part.toString()} (${file}); it is processed once the recording's outcome is known.`,
    )
  }

  async reset(): Promise<void> {
    await this.lifecycle.reset(async () => {
      const held = this.captureSession.heldSegments
      const part = this.captureSession.currentSegment
      const tab = this.captureSession.segmentTabs.get(part)
      this.captureFailure = undefined
      this.closingContextId = undefined
      this.failedStarts.clear()
      this.unconfirmedGap = undefined
      const { spooled } = await this.captureEngine.resetRecording()
      // Released first: keeping frames never holds a recording slot.
      await this.recordingSlotScheduler.release()
      this.warnAboutUnprocessedSegments(
        held.filter((segment) => !segment.spool),
      )
      await this.preserveUnencodedSpools([
        ...held.filter(isSpooledSegment).map((segment) => ({
          part: segment.part,
          plannedPath: segment.segment.recordingPath,
          spool: segment.spool,
          ...(segment.tab ? { tab: segment.tab } : {}),
        })),
        ...(spooled ? [{ ...spooled, part, ...(tab ? { tab } : {}) }] : []),
      ])
    })
  }

  // A reset normally follows finalization. Segments still held were stopped by
  // a recording whose finalization failed: their files stay, unprocessed.
  private warnAboutUnprocessedSegments(held: readonly HeldSegment[]): void {
    if (held.length === 0) {
      return
    }
    const files = held.map((segment) => segment.segment.recordingPath)
    this.log(
      'warn',
      `[WdioPuppeteerVideoService] Keeping ${held.length.toString()} unprocessed recording segment(s): ${files.join(', ')}`,
    )
  }

  /**
   * A spool of a kept or undecided recording is never deleted by a reset: it
   * becomes a frames file, or stays where it is if it cannot be moved, and a
   * warning names where its frames are. It is never encoded here, so a reset
   * after an encode step that was cancelled or ran out cannot start one.
   */
  private async preserveUnencodedSpools(
    spools: readonly UnencodedSpool[],
  ): Promise<void> {
    const storage = this.spoolStorage
    if (!storage) {
      return
    }
    for (const spool of spools) {
      const tab = spool.tab ? ` (tab ${spool.tab.ordinal.toString()})` : ''
      const frames = await storage.encoder.preserveFrames(spool)
      this.log(
        'warn',
        `[WdioPuppeteerVideoService] Segment ${spool.part.toString()}${tab} was not encoded before its recording was reset. ${frames}`,
      )
    }
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
      const spoolPath = this.createSpoolPath()
      const result = await this.captureEngine.startCapture({
        // A spooled segment's output is reserved only once it is encoded, so
        // a discarded recording leaves no placeholder.
        createOutput: async () =>
          spoolPath === undefined
            ? this.reserveRecordingOutput(this.createRecordingOutput())
            : this.createRecordingOutput(),
        ffmpegPath: this.ffmpegRuntime.resolvePath(),
        ...(spoolPath === undefined || !this.spoolBudget
          ? {}
          : { budget: this.spoolBudget }),
        ...(spoolPath === undefined ? {} : { spoolPath }),
        ...(target ? { target } : {}),
        transcodeOptions: this.options.processing.transcode,
      })
      if (!result.started) {
        return false
      }
      const spooling =
        spoolPath === undefined ? '' : ` (spooling frames to ${spoolPath})`
      this.log(
        'debug',
        `[WdioPuppeteerVideoService] Recording segment ${this.captureSession.currentSegment} to ${this.captureSession.activeSegment?.outputPath ?? 'unknown output'}${spooling}`,
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

  /**
   * A new spool file for the current segment when it is captured deferred,
   * named so an orphan can be traced to its recording and part.
   */
  private createSpoolPath(): string | undefined {
    const storage = this.spoolStorage
    if (!storage) {
      return undefined
    }
    const mode = selectCaptureMode({
      encoding: this.options.capture.encoding,
      retain: this.options.recording.retain,
      retryCount: this.recordingRetryCount,
    })
    // A recording that has used its spool allowance, or the volume's free
    // space, continues as live encoding: later segments start live.
    if (mode === 'live' || this.spoolBudget?.promoted) {
      return undefined
    }
    const fileName = formatSpoolFileName({
      part: this.captureSession.currentSegment,
      slug: this.captureSession.currentTestSlug,
      uuid: storage.uuid(),
    })
    if (fileName === undefined) {
      // Recovery would not recognize the name, so a crash could not recover
      // the spool: this segment records live instead.
      this.log(
        'debug',
        `[WdioPuppeteerVideoService] Recording segment ${this.captureSession.currentSegment.toString()} live: its spool name would not be recognized by orphan recovery.`,
      )
      return undefined
    }
    return path.join(storage.directory, fileName)
  }

  private createSpoolBudget(): SpoolBudget | undefined {
    const storage = this.spoolStorage
    if (!storage) {
      return undefined
    }
    return new SpoolBudget(
      storage.limits ?? DEFAULT_SPOOL_LIMITS,
      storage.diskSpace ?? nodeDiskSpace,
    )
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

const NOTHING_STOPPED: CaptureStopResult = Object.freeze({
  capturedSeconds: 0,
  segment: undefined,
  streamOk: false,
})

const replaceFileExtension = (
  filePath: string,
  format: OutputFormat,
): string => {
  const parsed = path.parse(filePath)
  return path.join(parsed.dir, `${parsed.name}.${format}`)
}
