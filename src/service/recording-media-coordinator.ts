import type { ResolvedWdioPuppeteerVideoServiceOptions } from '../types.js'
import type { FileSystemBoundary } from './boundaries.js'
import { drainBoundedTaskQueue } from './bounded-task-queue.js'
import type { CaptureSession } from './capture-session.js'
import type {
  ActiveSegment,
  DeferredMergeTask,
  DeferredPostProcessTask,
  DeferredTranscodeTask,
} from './constants.js'
import type { FfmpegRuntime } from './ffmpeg-runtime.js'
import type { ServiceLogger } from './logging.js'
import type { ManifestWorkerRecorder } from './manifest-runtime.js'
import type { MediaPipeline } from './media-pipeline.js'
import { describeError } from './normalization.js'
import * as artifactPaths from './paths.js'
import * as postProcess from './post-process.js'

export interface RecordingMediaCoordinatorOptions {
  readonly captureSession: CaptureSession
  readonly ffmpegRuntime: Pick<FfmpegRuntime, 'shouldTranscode'>
  readonly fileSystem: FileSystemBoundary
  readonly getManifestRecorder: () => ManifestWorkerRecorder | undefined
  readonly log: ServiceLogger
  readonly mediaPipeline: Pick<
    MediaPipeline,
    'merge' | 'reportFailure' | 'transcode'
  >
  readonly options: ResolvedWdioPuppeteerVideoServiceOptions
}

/** Owns immediate and deferred publication of captured media. */
export class RecordingMediaCoordinator {
  private readonly captureSession: CaptureSession
  private readonly ffmpegRuntime: Pick<FfmpegRuntime, 'shouldTranscode'>
  private readonly fileSystem: FileSystemBoundary
  private readonly getManifestRecorder: () => ManifestWorkerRecorder | undefined
  private readonly log: ServiceLogger
  private readonly mediaPipeline: Pick<
    MediaPipeline,
    'merge' | 'reportFailure' | 'transcode'
  >
  private readonly options: ResolvedWdioPuppeteerVideoServiceOptions
  private readonly tasks: DeferredPostProcessTask[] = []

  constructor(options: RecordingMediaCoordinatorOptions) {
    this.captureSession = options.captureSession
    this.ffmpegRuntime = options.ffmpegRuntime
    this.fileSystem = options.fileSystem
    this.getManifestRecorder = options.getManifestRecorder
    this.log = options.log
    this.mediaPipeline = options.mediaPipeline
    this.options = options.options
  }

  get pendingTaskCount(): number {
    return this.tasks.length
  }

  get pendingTasks(): readonly DeferredPostProcessTask[] {
    return Object.freeze([...this.tasks])
  }

  get hasPendingTasks(): boolean {
    return this.tasks.length > 0
  }

  get shouldDefer(): boolean {
    return this.options.processing.timing === 'after-worker'
  }

  enqueue(task: DeferredPostProcessTask): void {
    this.tasks.push(task)
  }

  async deleteRecordedSegments(): Promise<void> {
    const filesToDelete = [...this.captureSession.recordedPaths]
    await Promise.all(
      filesToDelete.map((file) =>
        this.fileSystem.unlink(file).catch(() => {
          // The artifact may already have been removed during cleanup.
        }),
      ),
    )
    this.dropTasksForPaths(filesToDelete)
    this.captureSession.clearRecordedPaths()
  }

  async queueDeferredMerge(): Promise<void> {
    const currentTestSlug = this.captureSession.currentTestSlug
    if (!currentTestSlug) {
      return
    }

    const segmentPaths = artifactPaths.collectCurrentTestSegmentPaths(
      currentTestSlug,
      this.captureSession.recordedPaths,
    )
    if (segmentPaths.length === 0) {
      return
    }

    const mergedFormat = artifactPaths.resolveMergeFormat(
      segmentPaths,
      'deferred merge',
      (message) => {
        this.log('warn', message)
      },
    )
    if (!mergedFormat) {
      return
    }

    const mergeTask = postProcess.createDeferredMergeTask({
      deleteSegments: this.options.processing.merge.deleteSegments,
      getMergedOutputPath: (format) =>
        artifactPaths.getMergedOutputPath(
          this.options.outputDir,
          currentTestSlug,
          format,
        ),
      mergedFormat,
      outputFormat: this.options.processing.format,
      segmentPaths,
      shouldTranscodeMergedOutput: this.ffmpegRuntime.shouldTranscode('mp4'),
      transcodeOptions: this.options.processing.transcode,
    })
    const manifestEntryId = this.getManifestRecorder()?.currentEntryId
    if (manifestEntryId) {
      mergeTask.manifestEntryId = manifestEntryId
    }

    this.dropTasksForPaths(segmentPaths)
    this.tasks.push(mergeTask)
    this.log(
      'debug',
      `[WdioPuppeteerVideoService] Queued deferred merge for ${segmentPaths.length} segments into ${mergeTask.mergedPath}.`,
    )
  }

  async mergeCurrentSegments(): Promise<void> {
    const currentTestSlug = this.captureSession.currentTestSlug
    if (!currentTestSlug) {
      return
    }

    const segmentPaths = artifactPaths.collectCurrentTestSegmentPaths(
      currentTestSlug,
      this.captureSession.recordedPaths,
    )
    if (segmentPaths.length === 0) {
      return
    }

    const mergedFormat = artifactPaths.resolveMergeFormat(
      segmentPaths,
      'merge',
      (message) => {
        this.log('warn', message)
      },
    )
    if (!mergedFormat) {
      return
    }

    const mergedPath = artifactPaths.getMergedOutputPath(
      this.options.outputDir,
      currentTestSlug,
      mergedFormat,
    )
    this.log(
      'debug',
      `[WdioPuppeteerVideoService] Attempting merge for ${segmentPaths.length} segments into ${mergedPath}`,
    )

    const publishedMergedPath = await this.mediaPipeline.merge({
      segmentPaths,
      mergedPath,
      deleteSegments: this.options.processing.merge.deleteSegments,
      writeFailureContext: 'merge',
      ffmpegOperation: 'segment merge',
    })
    if (!publishedMergedPath) {
      this.mediaPipeline.reportFailure(
        `Merge failed, keeping ${segmentPaths.length.toString()} original segment(s).`,
      )
      return
    }

    this.captureSession.addRecordedPath(publishedMergedPath)
    if (this.options.processing.merge.deleteSegments) {
      for (const segmentPath of segmentPaths) {
        this.captureSession.deleteRecordedPath(segmentPath)
      }
    }
  }

  async finalizeSegment(segment: ActiveSegment): Promise<void> {
    let recordedSize: number
    try {
      const stats = await this.fileSystem.stat(segment.recordingPath)
      recordedSize = stats.size ?? 0
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.mediaPipeline.reportFailure(
          `Recording file is missing: ${segment.recordingPath}`,
        )
        return
      }
      this.captureSession.addRecordedPath(segment.recordingPath)
      this.mediaPipeline.reportFailure(
        `Failed to inspect recording file, preserving the original capture: ${segment.recordingPath}. ${describeError(error)}`,
      )
      return
    }

    if (recordedSize === 0) {
      this.log(
        'warn',
        `[WdioPuppeteerVideoService] Recording file is empty: ${segment.recordingPath}`,
      )
      await this.fileSystem.unlink(segment.recordingPath).catch(() => {
        // Best-effort cleanup of an empty capture.
      })
      return
    }

    if (!segment.transcode) {
      this.captureSession.addRecordedPath(segment.outputPath)
      return
    }

    if (this.shouldDefer) {
      this.queueSegmentTranscode(segment)
      return
    }

    await this.transcodeSegment(segment)
  }

  async flush(): Promise<void> {
    if (!this.hasPendingTasks) {
      return
    }

    this.log(
      'info',
      `[WdioPuppeteerVideoService] Processing ${this.tasks.length} deferred post-processing task(s).`,
    )
    const failures = await drainBoundedTaskQueue(
      this.tasks,
      this.options.concurrency.maxPostProcessesPerProcess,
      async (task) => {
        if (task.kind === 'merge') {
          await this.executeMerge(task)
          return
        }
        await this.executeTranscode(task)
      },
    )
    for (const failure of failures) {
      this.log(
        'error',
        `[WdioPuppeteerVideoService] Deferred ${failure.task.kind} task failed:`,
        failure.error,
      )
    }

    const firstFailure = failures[0]
    if (firstFailure) {
      throw firstFailure.error
    }
  }

  async executeTranscode(task: DeferredTranscodeTask): Promise<void> {
    const inputExists = await this.fileSystem
      .stat(task.inputPath)
      .then(() => true)
      .catch(() => false)
    if (!inputExists) {
      await this.completeMissingTranscodeInput(task)
      this.mediaPipeline.reportFailure(
        `Deferred transcode input is missing: ${task.inputPath}`,
      )
      return
    }

    const transcodedPath = await this.mediaPipeline.transcode({
      deleteOriginal: task.deleteOriginal,
      ...(task.ffmpegArgs === undefined ? {} : { ffmpegArgs: task.ffmpegArgs }),
      inputPath: task.inputPath,
      outputPath: task.outputPath,
    })
    if (!transcodedPath) {
      await this.completeFailedTranscode(task)
      this.mediaPipeline.reportFailure(
        `Deferred transcode failed, keeping original recording: ${task.inputPath}`,
      )
      return
    }

    await this.completeSuccessfulTranscode(task, transcodedPath)
  }

  async executeMerge(task: DeferredMergeTask): Promise<void> {
    const mergedPath = await this.mediaPipeline.merge({
      segmentPaths: task.segmentPaths,
      mergedPath: task.mergedPath,
      deleteSegments: task.deleteSegments,
      writeFailureContext: 'deferred merge',
      ffmpegOperation: 'deferred segment merge',
    })
    if (!mergedPath) {
      await this.completeFailedMerge(task)
      this.mediaPipeline.reportFailure(
        `Deferred merge failed, keeping ${task.segmentPaths.length.toString()} original segment(s).`,
      )
      return
    }

    if (!task.transcodeToMp4) {
      await this.completeSuccessfulMerge(task, mergedPath)
      return
    }

    await this.executeTranscode(
      createFollowUpTranscodeTask(task, mergedPath, task.transcodeToMp4),
    )
  }

  dropTasksForPaths(paths: readonly string[]): void {
    if (paths.length === 0 || this.tasks.length === 0) {
      return
    }

    const blockedPaths = new Set(paths)
    const filteredTasks = this.tasks.filter(
      (task) => !taskTouchesPaths(task, blockedPaths),
    )
    this.tasks.length = 0
    this.tasks.push(...filteredTasks)
  }

  private queueSegmentTranscode(segment: ActiveSegment): void {
    this.captureSession.addRecordedPath(segment.recordingPath)
    if (this.options.processing.merge.enabled) {
      return
    }

    const task = postProcess.createDeferredTranscodeTask(
      segment.recordingPath,
      segment.outputPath,
      segment.transcodeOptions,
    )
    const manifestEntryId = this.getManifestRecorder()?.currentEntryId
    if (manifestEntryId) {
      task.manifestEntryId = manifestEntryId
    }
    this.tasks.push(task)
    this.log(
      'debug',
      `[WdioPuppeteerVideoService] Queued deferred transcode: ${segment.recordingPath} -> ${segment.outputPath}`,
    )
  }

  private async transcodeSegment(segment: ActiveSegment): Promise<void> {
    const transcodedPath = await this.mediaPipeline.transcode({
      deleteOriginal: segment.transcodeOptions.deleteOriginal,
      ...(segment.transcodeOptions.ffmpegArgs === undefined
        ? {}
        : { ffmpegArgs: segment.transcodeOptions.ffmpegArgs }),
      inputPath: segment.recordingPath,
      outputPath: segment.outputPath,
    })
    if (transcodedPath) {
      segment.outputPath = transcodedPath
      this.captureSession.addRecordedPath(transcodedPath)
      return
    }

    this.log(
      'warn',
      `[WdioPuppeteerVideoService] Transcode failed, keeping original recording: ${segment.recordingPath}`,
    )
    this.captureSession.addRecordedPath(segment.recordingPath)
    this.mediaPipeline.reportFailure(
      `Transcode failed, keeping original recording: ${segment.recordingPath}`,
      true,
    )
  }

  private async completeMissingTranscodeInput(
    task: DeferredTranscodeTask,
  ): Promise<void> {
    if (!task.manifestEntryId) {
      return
    }
    await this.getManifestRecorder()?.completeDeferred(task.manifestEntryId, {
      decision: 'failed',
      paths: [task.inputPath],
      reason: 'deferred-transcode-input-missing',
      processingOutcome: 'failed',
      processingOperation: 'transcode',
    })
  }

  private async completeFailedTranscode(
    task: DeferredTranscodeTask,
  ): Promise<void> {
    if (!task.manifestEntryId) {
      return
    }
    await this.getManifestRecorder()?.completeDeferred(task.manifestEntryId, {
      decision: 'recorded',
      paths: [task.inputPath],
      reason: 'deferred-transcode-failed-original-preserved',
      processingOutcome: 'failed',
      processingOperation: 'transcode',
    })
  }

  private async completeSuccessfulTranscode(
    task: DeferredTranscodeTask,
    transcodedPath: string,
  ): Promise<void> {
    if (!task.manifestEntryId) {
      return
    }
    await this.getManifestRecorder()?.completeDeferred(task.manifestEntryId, {
      decision: 'recorded',
      paths: [transcodedPath],
      processingOutcome: 'completed',
      processingOperation: 'transcode',
    })
  }

  private async completeFailedMerge(task: DeferredMergeTask): Promise<void> {
    if (!task.manifestEntryId) {
      return
    }
    await this.getManifestRecorder()?.completeDeferred(task.manifestEntryId, {
      decision: 'recorded',
      paths: task.segmentPaths,
      reason: 'deferred-merge-failed-segments-preserved',
      processingOutcome: 'failed',
      processingOperation: 'merge',
    })
  }

  private async completeSuccessfulMerge(
    task: DeferredMergeTask,
    mergedPath: string,
  ): Promise<void> {
    if (!task.manifestEntryId) {
      return
    }
    await this.getManifestRecorder()?.completeDeferred(task.manifestEntryId, {
      decision: 'recorded',
      paths: [mergedPath],
      processingOutcome: 'completed',
      processingOperation: 'merge',
    })
  }
}

const createFollowUpTranscodeTask = (
  task: DeferredMergeTask,
  mergedPath: string,
  transcode: NonNullable<DeferredMergeTask['transcodeToMp4']>,
): DeferredTranscodeTask => ({
  kind: 'transcode',
  inputPath: mergedPath,
  outputPath: transcode.outputPath,
  deleteOriginal: transcode.deleteOriginal,
  ...(transcode.ffmpegArgs === undefined
    ? {}
    : { ffmpegArgs: transcode.ffmpegArgs }),
  ...(task.manifestEntryId ? { manifestEntryId: task.manifestEntryId } : {}),
})

const taskTouchesPaths = (
  task: DeferredPostProcessTask,
  blockedPaths: ReadonlySet<string>,
): boolean => {
  if (task.kind === 'transcode') {
    return blockedPaths.has(task.inputPath) || blockedPaths.has(task.outputPath)
  }
  return (
    blockedPaths.has(task.mergedPath) ||
    task.segmentPaths.some((segmentPath) => blockedPaths.has(segmentPath)) ||
    (task.transcodeToMp4 !== undefined &&
      blockedPaths.has(task.transcodeToMp4.outputPath))
  )
}
