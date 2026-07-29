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
import type { CaptureSession } from './capture-session.js'
import type { ActiveSegment, OutputFormat } from './constants.js'
import type { FfmpegRuntime } from './ffmpeg-runtime.js'
import type { ServiceLogger } from './logging.js'
import type { ManifestWorkerRecorder } from './manifest-runtime.js'
import * as artifactPaths from './paths.js'
import type {
  CaptureSegmentOutput,
  CaptureWindowOperations,
  PuppeteerCaptureEngine,
} from './puppeteer-capture-engine.js'
import { RecordingLifecycle } from './recording-lifecycle.js'
import type { RecordingMediaCoordinator } from './recording-media-coordinator.js'
import type { RecordingSlotScheduler } from './recording-slots.js'

type CaptureEnginePort = Pick<
  PuppeteerCaptureEngine,
  | 'afterWindowCommand'
  | 'beforeWindowCommand'
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
export class RecordingController {
  private readonly captureEngine: CaptureEnginePort
  private readonly captureSession: CaptureSession
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
    return this.startRecording()
  }

  async finalizeMedia(
    passed: boolean,
    keepArtifacts: boolean,
  ): Promise<{ deferred: boolean; paths: readonly string[] }> {
    if (!this.captureSession.currentTestSlug) {
      return { deferred: false, paths: [] }
    }

    const deferredTaskCount = this.media.pendingTaskCount
    await this.lifecycle.finalize({
      stopRecording: async () => {
        await this.stopRecording()
      },
      processArtifacts: async () => {
        this.log(
          'debug',
          `[WdioPuppeteerVideoService] Finished test recording (passed=${passed}, keepArtifacts=${keepArtifacts}).`,
        )
        if (!keepArtifacts) {
          await this.media.deleteRecordedSegments()
          return
        }
        if (!this.options.processing.merge.enabled) {
          return
        }
        if (this.media.shouldDefer) {
          await this.media.queueDeferredMerge()
          return
        }
        await this.media.mergeCurrentSegments()
      },
    })

    return {
      deferred: this.media.pendingTaskCount > deferredTaskCount,
      paths: this.captureSession.recordedPaths,
    }
  }

  async stopRecording(): Promise<void> {
    let activeSegment: ActiveSegment | undefined
    let streamOk = false
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
        const stoppedCapture = await this.captureEngine.stopCapture()
        activeSegment = stoppedCapture.segment
        streamOk = stoppedCapture.streamOk
      },
      processCapture: async () => {
        try {
          if (!activeSegment) {
            return
          }
          if (!streamOk) {
            this.log(
              'warn',
              `[WdioPuppeteerVideoService] Recording stream did not finish cleanly for: ${activeSegment.recordingPath}`,
            )
          }
          await releaseRecordingSlot()
          await this.media.finalizeSegment(activeSegment)
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
      await this.captureEngine.resetRecording()
      await this.recordingSlotScheduler.release()
    })
  }

  async runSerialized(task: () => Promise<void>): Promise<void> {
    const wrappedTask = async (): Promise<void> => {
      try {
        await task()
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
      startRecording: () => this.startRecording(),
      stopRecording: () => this.stopRecording(),
    }
  }

  private async startRecording(): Promise<boolean> {
    if (
      !this.captureSession.browser ||
      !this.captureSession.currentTestSlug ||
      this.captureSession.recorder
    ) {
      return false
    }
    return this.lifecycle.start(async () => this.startRecordingOperation())
  }

  private async startRecordingOperation(): Promise<boolean> {
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
        transcodeOptions: this.options.processing.transcode,
      })
      if (!result.started) {
        return false
      }
      this.log(
        'debug',
        `[WdioPuppeteerVideoService] Recording segment ${this.captureSession.currentSegment} to ${this.captureSession.activeSegment?.outputPath ?? 'unknown output'}`,
      )
      this.getManifestRecorder()?.markCaptureStarted(result.dimensions)
      return true
    } catch (error) {
      this.log(
        'error',
        '[WdioPuppeteerVideoService] Failed to start recording:',
        error,
      )
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
