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
  // Where each task published its output. Collision renaming can move it off
  // the planned path, which may hold another recording.
  private readonly publishedPaths = new WeakMap<
    DeferredPostProcessTask,
    string
  >()
  // Tasks that have reported their result to the manifest.
  private readonly settledTasks = new WeakSet<DeferredPostProcessTask>()
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

  queueDeferredMerge(): void {
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

  async finalizeSegment(
    segment: ActiveSegment,
    options: Readonly<{ keepArtifacts?: boolean }> = {},
  ): Promise<void> {
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

    if (!segment.transcode || options.keepArtifacts === false) {
      this.captureSession.addRecordedPath(
        options.keepArtifacts === false
          ? segment.recordingPath
          : segment.outputPath,
      )
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
    this.expectEntryTasks(this.tasks)
    const failures = await drainBoundedTaskQueue(
      this.tasks,
      this.options.concurrency.maxPostProcessesPerProcess,
      async (task) => {
        try {
          if (task.kind === 'merge') {
            await this.executeMerge(task)
            return
          }
          await this.executeTranscode(task)
        } catch (error) {
          await this.completeAbandonedTask(task, readInputPaths(task))
          throw error
        }
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
    // A segment's output stands in for that segment alone.
    await this.transcodeDeferred(task, [task.inputPath])
  }

  private async transcodeDeferred(
    task: DeferredTranscodeTask,
    replaces: readonly string[] | undefined,
  ): Promise<void> {
    const inputExists = await this.fileSystem
      .stat(task.inputPath)
      .then(() => true)
      .catch(() => false)
    if (!inputExists) {
      await this.completeMissingTranscodeInput(task, replaces)
      this.mediaPipeline.reportFailure(
        `Deferred transcode input is missing: ${task.inputPath}`,
      )
      return
    }

    const transcodedPath = await this.mediaPipeline.transcode({
      deleteOriginal: task.deleteOriginal,
      ...(task.ffmpegArgs === undefined ? {} : { ffmpegArgs: task.ffmpegArgs }),
      inputPath: task.inputPath,
      onPublished: (publishedPath) => {
        this.publishedPaths.set(task, publishedPath)
      },
      outputPath: task.outputPath,
    })
    if (!transcodedPath) {
      await this.completeFailedTranscode(task, replaces)
      this.mediaPipeline.reportFailure(
        `Deferred transcode failed, keeping original recording: ${task.inputPath}`,
      )
      return
    }

    await this.completeSuccessfulTranscode(task, transcodedPath, replaces)
  }

  async executeMerge(task: DeferredMergeTask): Promise<void> {
    const mergedPath = await this.mediaPipeline.merge({
      segmentPaths: task.segmentPaths,
      mergedPath: task.mergedPath,
      deleteSegments: task.deleteSegments,
      writeFailureContext: 'deferred merge',
      ffmpegOperation: 'deferred segment merge',
      onPublished: (publishedPath) => {
        this.publishedPaths.set(task, publishedPath)
      },
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

    // The merged output replaces every segment the entry listed.
    const followUp = createFollowUpTranscodeTask(
      task,
      mergedPath,
      task.transcodeToMp4,
    )
    try {
      await this.transcodeDeferred(followUp, undefined)
    } catch (error) {
      // The merge succeeded, so the files it left stand in for every segment.
      await this.completeAbandonedTask(followUp, undefined)
      throw error
    } finally {
      if (this.settledTasks.has(followUp)) {
        this.settledTasks.add(task)
      }
    }
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

  /** Each manifest entry waits for all of its deferred tasks. */
  private expectEntryTasks(tasks: readonly DeferredPostProcessTask[]): void {
    const recorder = this.getManifestRecorder()
    const counts = new Map<string, number>()
    for (const task of tasks) {
      if (task.manifestEntryId) {
        counts.set(
          task.manifestEntryId,
          (counts.get(task.manifestEntryId) ?? 0) + 1,
        )
      }
    }
    for (const [entryId, count] of counts) {
      recorder?.expectDeferredTasks(entryId, count)
    }
  }

  /**
   * A task that threw still settles its entry, as a failure. It lists the
   * files that survived: an output it published before the error replaces its
   * inputs, which may already be deleted. A file at the planned output path is
   * not evidence of publication.
   */
  private async completeAbandonedTask(
    task: DeferredPostProcessTask,
    replaces: readonly string[] | undefined,
  ): Promise<void> {
    if (!task.manifestEntryId || this.settledTasks.has(task)) {
      return
    }
    this.settledTasks.add(task)
    const publishedPath = this.publishedPaths.get(task)
    const published = publishedPath
      ? await this.findExisting([publishedPath])
      : []
    const paths =
      published.length > 0
        ? published
        : await this.findExisting(readInputPaths(task))
    await this.getManifestRecorder()
      ?.completeDeferred(task.manifestEntryId, {
        decision: paths.length > 0 ? 'recorded' : 'failed',
        paths,
        reason: 'deferred-processing-error',
        processingOutcome: 'failed',
        processingOperation: task.kind,
        ...(replaces ? { replaces } : {}),
      })
      .catch(() => undefined)
  }

  private async findExisting(paths: readonly string[]): Promise<string[]> {
    const found = await Promise.all(
      paths.map(async (filePath) =>
        this.fileSystem
          .stat(filePath)
          .then(() => filePath)
          .catch(() => undefined),
      ),
    )
    return found.filter((filePath) => filePath !== undefined)
  }

  private async completeMissingTranscodeInput(
    task: DeferredTranscodeTask,
    replaces: readonly string[] | undefined,
  ): Promise<void> {
    this.settledTasks.add(task)
    if (!task.manifestEntryId) {
      return
    }
    await this.getManifestRecorder()?.completeDeferred(task.manifestEntryId, {
      decision: 'failed',
      paths: [task.inputPath],
      reason: 'deferred-transcode-input-missing',
      processingOutcome: 'failed',
      processingOperation: 'transcode',
      ...(replaces ? { replaces } : {}),
    })
  }

  private async completeFailedTranscode(
    task: DeferredTranscodeTask,
    replaces: readonly string[] | undefined,
  ): Promise<void> {
    this.settledTasks.add(task)
    if (!task.manifestEntryId) {
      return
    }
    await this.getManifestRecorder()?.completeDeferred(task.manifestEntryId, {
      decision: 'recorded',
      paths: [task.inputPath],
      reason: 'deferred-transcode-failed-original-preserved',
      processingOutcome: 'failed',
      processingOperation: 'transcode',
      ...(replaces ? { replaces } : {}),
    })
  }

  private async completeSuccessfulTranscode(
    task: DeferredTranscodeTask,
    transcodedPath: string,
    replaces: readonly string[] | undefined,
  ): Promise<void> {
    this.settledTasks.add(task)
    if (!task.manifestEntryId) {
      return
    }
    await this.getManifestRecorder()?.completeDeferred(task.manifestEntryId, {
      decision: 'recorded',
      paths: [transcodedPath],
      processingOutcome: 'completed',
      processingOperation: 'transcode',
      ...(replaces ? { replaces } : {}),
    })
  }

  private async completeFailedMerge(task: DeferredMergeTask): Promise<void> {
    this.settledTasks.add(task)
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
    this.settledTasks.add(task)
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

/**
 * A task's own inputs. They are also the entry paths its result supersedes,
 * as its completions report them.
 */
const readInputPaths = (task: DeferredPostProcessTask): string[] =>
  task.kind === 'merge' ? [...task.segmentPaths] : [task.inputPath]

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
