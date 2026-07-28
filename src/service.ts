import path from 'node:path'
import type { Frameworks, Services } from '@wdio/types'
import type { Browser } from 'webdriverio'
import * as artifactIntegrity from './service/artifact-integrity.js'
import type {
  ClockBoundary,
  FileSystemBoundary,
  ProcessBoundary,
} from './service/boundaries.js'
import { CaptureSession } from './service/capture-session.js'
import {
  createWorkerCompositionRoot,
  type WorkerCompositionOverrides,
  type WorkerFfmpegRunner,
} from './service/composition.js'
import {
  type ActiveSegment,
  CI_TRANSCODE_FFMPEG_ARGS,
  type DeferredMergeTask,
  type DeferredPostProcessTask,
  type DeferredTranscodeTask,
  type MergeExecutionOptions,
  type OutputFormat,
  type ResolvedTranscodeOptions,
} from './service/constants.js'
import * as ffmpeg from './service/ffmpeg.js'
import type { FfmpegProcessRegistry } from './service/ffmpeg-runner.js'
import {
  createLauncherRegistrationError,
  inspectLauncherWorkerContext,
} from './service/launcher-context.js'
import * as logging from './service/logging.js'
import {
  hasManifestWorkerContexts,
  ManifestWorkerRecorder,
  normalizeManifestFramework,
  readManifestRunContext,
  readManifestWorkerContext,
} from './service/manifest-runtime.js'
import * as normalization from './service/normalization.js'
import { resolveServiceConfiguration } from './service/options.js'
import * as artifactPaths from './service/paths.js'
import * as postProcess from './service/post-process.js'
import { isChromiumSession } from './service/protocol.js'
import { PuppeteerCaptureEngine } from './service/puppeteer-capture-engine.js'
import {
  normalizeScenarioEntity,
  normalizeScenarioOutcome,
  normalizeTestEntity,
  normalizeTestOutcome,
} from './service/recording-entity.js'
import { RecordingLifecycle } from './service/recording-lifecycle.js'
import type {
  PostProcessSlotScheduler,
  RecordingSlotScheduler,
} from './service/recording-slots.js'
import type { WorkerRecordingCoordinatorPort } from './service/worker-recording-coordinator.js'
import type {
  LogLevel,
  ResolvedWdioPuppeteerVideoServiceOptions,
  WdioPuppeteerVideoServiceOptions,
} from './types.js'
import {
  buildFullSessionIdToken,
  buildSessionIdToken,
  buildTestSlugFromMetadata,
  collectSlugMetadata,
  reserveUniqueSlug,
  type SlugMetadata,
} from './video-name-utils.js'

const replaceFileExtension = (
  filePath: string,
  format: OutputFormat,
): string => {
  const parsed = path.parse(filePath)
  return path.join(parsed.dir, `${parsed.name}.${format}`)
}

const validateLauncherWorkerConfiguration = (config: unknown): void => {
  const launcherContext = inspectLauncherWorkerContext(config)
  if (launcherContext.status !== 'valid') {
    throw createLauncherRegistrationError(launcherContext.status)
  }
  if (!hasManifestWorkerContexts(config)) {
    throw createLauncherRegistrationError('malformed')
  }
  if (
    launcherContext.context.manifestContextAvailable &&
    !readManifestRunContext(config)
  ) {
    throw createLauncherRegistrationError('malformed')
  }
}

/**
 * WebdriverIO Service to record videos using Puppeteer and FFmpeg
 */
export default class WdioPuppeteerVideoService
  implements Services.ServiceInstance
{
  private readonly _options: ResolvedWdioPuppeteerVideoServiceOptions
  private readonly _clock: ClockBoundary
  private readonly _fileSystem: FileSystemBoundary
  private readonly _process: ProcessBoundary
  private readonly _runFfmpegProcess: WorkerFfmpegRunner
  private readonly _writeLog: typeof logging.writeLog
  private readonly _captureSession: CaptureSession
  private readonly _captureEngine: PuppeteerCaptureEngine
  private _isChromium = false
  private _recordingDisabledReason: string | undefined
  private _sessionIdToken = ''
  private _sessionIdFullToken = ''
  private _logLevel: LogLevel = 'warn'
  private readonly _hasExplicitLogLevel: boolean
  private _ffmpegAvailable = false
  private _resolvedFfmpegPath: string | undefined
  private _ffmpegCandidates: string[] = []
  private _ffmpegInitializationTask: Promise<boolean> | undefined
  private _ffmpegInitializationCompleted = false
  private _recordingTask: Promise<void> = Promise.resolve()
  private _teardownTask: Promise<void> | undefined
  private readonly _deferredPostProcessTasks: DeferredPostProcessTask[] = []
  private _warnedAboutMp4Compatibility = false
  private _warnedAboutMp4AutoFallback = false
  private _warnedAboutMissingFfmpeg = false
  private _forceMp4Transcode = false
  private readonly _slugUsageCount = new Map<string, number>()
  private readonly _maxSlugLength: number
  private readonly _recordingSlotScheduler: RecordingSlotScheduler
  private readonly _postProcessSlotScheduler: PostProcessSlotScheduler
  private readonly _recordingLifecycle = new RecordingLifecycle()
  private readonly _ffmpegProcessRegistry: FfmpegProcessRegistry
  private _manifestRecorder: ManifestWorkerRecorder | undefined
  private readonly _recordingCoordinator: WorkerRecordingCoordinatorPort

  constructor(
    options: WdioPuppeteerVideoServiceOptions = {},
    _capabilities?: unknown,
    config?: unknown,
    compositionOverrides?: WorkerCompositionOverrides,
  ) {
    if (config !== undefined) {
      validateLauncherWorkerConfiguration(config)
    }
    const resolvedConfiguration = resolveServiceConfiguration(options)
    this._hasExplicitLogLevel = resolvedConfiguration.hasExplicitLogLevel
    this._logLevel = resolvedConfiguration.logLevel
    this._maxSlugLength = resolvedConfiguration.maxSlugLength
    this._options = resolvedConfiguration.options
    const composition = createWorkerCompositionRoot(compositionOverrides)
    this._clock = composition.clock
    this._fileSystem = composition.fileSystem
    this._process = composition.process
    this._runFfmpegProcess = composition.runFfmpeg
    this._writeLog = composition.writeLog
    this._ffmpegProcessRegistry = composition.createFfmpegProcessRegistry()
    this._captureSession = new CaptureSession()
    this._captureEngine = new PuppeteerCaptureEngine({
      capture: this._options.capture,
      clock: this._clock,
      connectPuppeteer: composition.connectPuppeteer,
      fileSystem: this._fileSystem,
      getSessionToken: () => this._sessionIdToken,
      log: (level, message, details) => {
        this._log(level, message, details)
      },
      onConnectionFailure: (reason) => {
        this._disableRecordingForWorker(reason)
      },
      onProtocolChanged: (protocol) => {
        this._manifestRecorder?.updateProtocol(protocol)
      },
      session: this._captureSession,
      startScreencast: composition.startScreencast,
      uuid: composition.uuid,
    })
    const allureIntegration = composition.createAllureIntegration(
      this._options.integrations.allure,
      (level, message, details) => {
        this._log(level, message, details)
      },
    )
    this._recordingSlotScheduler = composition.createRecordingSlotScheduler(
      this._options,
      (level, message, details) => {
        this._log(level, message, details)
      },
    )
    this._postProcessSlotScheduler = composition.createPostProcessSlotScheduler(
      this._options,
      (level, message, details) => {
        this._log(level, message, details)
      },
    )
    this._recordingCoordinator = composition.createRecordingCoordinator({
      actions: {
        finalizeMedia: (passed, keepArtifacts) =>
          this._finalizeRecordingMedia(passed, keepArtifacts),
        getAvailability: () => ({
          available: this._canUseRecordingHooks(),
          ...(this._recordingDisabledReason
            ? { reason: this._recordingDisabledReason }
            : {}),
        }),
        getRecordedPaths: () => this._captureSession.recordedPaths,
        isRecordingActive: () => this._captureSession.isRecordingActive,
        resetRecording: () => this._resetTestState(),
        runSerialized: (task) => this._runSerializedRecordingTask(task),
        startRecording: (metadata, retryCount) =>
          this._startRecordingForMetadata(metadata, retryCount),
      },
      ...(allureIntegration ? { allure: allureIntegration } : {}),
      getLogLevel: () => this._logLevel,
      log: (level, message, details) => {
        this._log(level, message, details)
      },
      options: this._options,
    })
  }

  async beforeSession(
    config: unknown,
    _capabilities: WebdriverIO.Capabilities,
    _specs: string[],
    cid: string,
  ): Promise<void> {
    validateLauncherWorkerConfiguration(config)
    const manifestContext = readManifestRunContext(config)
    const framework = normalizeManifestFramework(
      (config as { framework?: unknown } | undefined)?.framework,
    )
    this._manifestRecorder = manifestContext
      ? new ManifestWorkerRecorder({
          context: manifestContext,
          cid,
          framework,
          failurePolicy: this._options.failurePolicy,
          onJournalError: (operation, error) => {
            this._log(
              'warn',
              `[WdioPuppeteerVideoService] Failed to ${operation}: ${normalization.describeError(error)}.`,
            )
          },
        })
      : undefined
    const workerContext = readManifestWorkerContext(config, cid)
    if (!workerContext) {
      throw createLauncherRegistrationError('malformed')
    }
    const specFileRetryAttempt = workerContext.specFileRetryAttempt
    this._recordingCoordinator.configureSession({
      framework,
      ...(this._manifestRecorder ? { manifest: this._manifestRecorder } : {}),
      specFileRetryAttempt,
    })
    this._log(
      'debug',
      `[WdioPuppeteerVideoService] Hydrated launcher retry context for cid=${cid}: ${specFileRetryAttempt.toString()}`,
    )
  }

  async before(
    _capabilities: WebdriverIO.Capabilities,
    specs: string[],
    browser: Browser,
  ): Promise<void> {
    this._captureSession.setBrowser(browser)
    this._recordingDisabledReason = undefined
    this._recordingCoordinator.beginWorker(specs)

    if (!this._hasExplicitLogLevel) {
      const inheritedLogLevel = logging.resolveWdioLogLevel(browser)
      this._logLevel = logging.normalizeLogLevel(inheritedLogLevel)
    }

    this._sessionIdToken = buildSessionIdToken(browser.sessionId)
    this._sessionIdFullToken = buildFullSessionIdToken(browser.sessionId)
    const caps = browser.capabilities
    this._isChromium = isChromiumSession(caps)
    this._captureEngine.resetConnection()
    const browserVersion = caps.browserVersion
    const browserName = caps.browserName
    this._manifestRecorder?.configureSession({
      sessionId: browser.sessionId,
      ...(typeof browserName === 'string' ? { browserName } : {}),
      ...(typeof browserVersion === 'string' ? { browserVersion } : {}),
      protocol: this._captureSession.protocol,
    })

    if (!this._isChromium) {
      this._log(
        'warn',
        '[WdioPuppeteerVideoService] Video recording is only supported on Chromium-based browsers.',
      )
      return
    }
    if (browser.isMultiremote) {
      this._disableRecordingForWorker(
        'multiremote sessions are not supported; configure recording for a single-browser WDIO worker',
      )
      return
    }
    this._ffmpegAvailable = false
    this._resolvedFfmpegPath = undefined
    this._ffmpegCandidates = []
    this._ffmpegInitializationTask = undefined
    this._ffmpegInitializationCompleted = false

    await this._fileSystem.mkdir(this._options.outputDir).catch((error) => {
      this._log(
        'warn',
        `[WdioPuppeteerVideoService] Failed to create output directory (${this._options.outputDir}): ${normalization.describeError(error)}`,
      )
      this._disableRecordingForWorker('output directory is unavailable')
    })
  }

  async beforeTest(test: Frameworks.Test, context: unknown): Promise<void> {
    await this._recordingCoordinator.beginEntity(
      normalizeTestEntity(
        test,
        context,
        this._recordingCoordinator.framework,
        this._options.artifacts.naming.style,
      ),
    )
  }

  async afterTest(
    test: Frameworks.Test,
    _context: unknown,
    result: Frameworks.TestResult,
  ): Promise<void> {
    await this._recordingCoordinator.endEntity(
      normalizeTestOutcome(test, result),
    )
  }

  async beforeScenario(
    world: Frameworks.World,
    context: unknown,
  ): Promise<void> {
    await this._recordingCoordinator.beginEntity(
      normalizeScenarioEntity(
        world,
        context,
        this._options.artifacts.naming.style,
      ),
    )
  }

  async afterScenario(
    _world: Frameworks.World,
    result: Frameworks.PickleResult,
  ): Promise<void> {
    await this._recordingCoordinator.endEntity(normalizeScenarioOutcome(result))
  }

  async after(): Promise<void> {
    await this._teardownRecording('after')
  }

  async afterSession(): Promise<void> {
    let failure: { error: unknown } | undefined
    try {
      await this._teardownRecording('afterSession')
    } catch (error) {
      failure = { error }
    }
    try {
      await this._manifestRecorder?.flush()
    } catch (error) {
      failure ??= { error }
    } finally {
      this._captureSession.clearBrowser()
      this._isChromium = false
    }
    if (failure) {
      throw failure.error
    }
  }

  async onReload(oldSessionId: string, newSessionId: string): Promise<void> {
    await this._teardownRecording('onReload')
    this._captureEngine.resetConnection()
    this._sessionIdToken = buildSessionIdToken(newSessionId)
    this._sessionIdFullToken = buildFullSessionIdToken(newSessionId)
    const capabilities = this._captureSession.browser?.capabilities as
      | WebdriverIO.Capabilities
      | undefined
    const browserVersion = capabilities?.browserVersion
    const browserName = capabilities?.browserName
    this._manifestRecorder?.configureSession({
      sessionId: newSessionId,
      ...(typeof browserName === 'string' ? { browserName } : {}),
      ...(typeof browserVersion === 'string' ? { browserVersion } : {}),
      protocol: this._captureSession.protocol,
    })
    this._log(
      'debug',
      `[WdioPuppeteerVideoService] Reset recording lifecycle for session reload ${buildSessionIdToken(oldSessionId)} -> ${this._sessionIdToken}.`,
    )
  }

  private async _teardownRecording(
    source: 'after' | 'afterSession' | 'onReload',
  ): Promise<void> {
    this._ffmpegProcessRegistry.terminateAll()
    if (this._teardownTask) {
      await this._teardownTask
      return
    }

    const task = this._runSerializedRecordingTask(async () => {
      try {
        if (this._captureSession.isRecordingActive) {
          if (
            this._recordingCoordinator.isSpecScope &&
            this._captureSession.currentTestSlug
          ) {
            await this._recordingCoordinator.finalizeSpecRecording()
          } else {
            await this._stopRecording()
            await this._resetTestState()
          }
        }

        await this._flushDeferredPostProcessTasks()
      } finally {
        if (
          this._captureSession.isRecordingActive ||
          this._recordingSlotScheduler.ownsRecordingSlot ||
          this._recordingSlotScheduler.ownsGlobalRecordingSlot
        ) {
          await this._resetTestState()
        }
        if (
          this._postProcessSlotScheduler.ownsPostProcessSlot ||
          this._postProcessSlotScheduler.ownsGlobalPostProcessSlot
        ) {
          await this._postProcessSlotScheduler.release()
        }
        this._recordingCoordinator.resetWorkerState()
        this._log(
          'trace',
          `[WdioPuppeteerVideoService] Recording teardown completed from ${source}.`,
        )
      }
    })
    this._teardownTask = task
    try {
      await task
    } finally {
      this._teardownTask = undefined
    }
  }

  async beforeCommand(commandName: string): Promise<void> {
    if (!this._canUseRecordingHooks()) {
      return
    }

    if (!this._captureSession.currentTestSlug) {
      return
    }

    if (this._options.recording.windowChanges !== 'segment') {
      return
    }

    await this._captureEngine.beforeWindowCommand(commandName, {
      runSerialized: (task) => this._runSerializedRecordingTask(task),
      startRecording: () => this._startRecording(),
      stopRecording: () => this._stopRecording(),
    })
  }

  async afterCommand(commandName: string): Promise<void> {
    if (!this._canUseRecordingHooks()) {
      return
    }

    if (!this._captureSession.currentTestSlug) {
      return
    }

    if (this._options.recording.windowChanges !== 'segment') {
      return
    }

    await this._captureEngine.afterWindowCommand(commandName, {
      runSerialized: (task) => this._runSerializedRecordingTask(task),
      startRecording: () => this._startRecording(),
      stopRecording: () => this._stopRecording(),
    })
  }

  private async _startRecording(): Promise<boolean> {
    if (
      !this._captureSession.browser ||
      !this._captureSession.currentTestSlug ||
      this._captureSession.recorder
    ) {
      return false
    }

    return this._recordingLifecycle.start(async () => {
      return this._startRecordingOperation()
    })
  }

  private async _startRecordingOperation(): Promise<boolean> {
    if (
      !this._captureSession.browser ||
      !this._captureSession.currentTestSlug
    ) {
      return false
    }

    const ffmpegReady = await this._ensureFfmpegReady()
    if (!ffmpegReady) {
      return false
    }

    const acquiredRecordingSlot = await this._acquireRecordingSlotForStart()
    if (!acquiredRecordingSlot) {
      return false
    }

    try {
      const result = await this._captureEngine.startCapture({
        createOutput: async () =>
          this._reserveRecordingOutput(this._createRecordingOutput()),
        ffmpegPath: this._resolveFfmpegPath(),
        transcodeOptions: this._createResolvedTranscodeOptions(),
      })
      if (!result.started) {
        return false
      }
      this._log(
        'debug',
        `[WdioPuppeteerVideoService] Recording segment ${this._captureSession.currentSegment} to ${this._captureSession.activeSegment?.outputPath ?? 'unknown output'}`,
      )
      this._manifestRecorder?.markCaptureStarted(result.dimensions)
      return true
    } catch (e) {
      this._log(
        'error',
        '[WdioPuppeteerVideoService] Failed to start recording:',
        e,
      )
      return false
    } finally {
      if (acquiredRecordingSlot && !this._captureSession.recorder) {
        await this._recordingSlotScheduler.release()
      }
    }
  }

  private async _acquireRecordingSlotForStart(): Promise<boolean> {
    const acquiredSlot = await this._recordingSlotScheduler.acquire()
    if (acquiredSlot) {
      return true
    }

    const recordingStartMode = this._options.concurrency.startMode
    const timeoutSuffix =
      recordingStartMode === 'fast-fail'
        ? ` within ${this._options.concurrency.startTimeoutMs.toString()}ms`
        : ''
    this._log(
      'warn',
      `[WdioPuppeteerVideoService] Recording slot acquisition failed${timeoutSuffix}. Recording skipped for this segment.`,
    )
    return false
  }

  private _createRecordingOutput(): {
    outputFormat: OutputFormat
    outputPath: string
    recordingFormat: OutputFormat
    recordingPath: string
    transcodeEnabled: boolean
  } {
    const outputFormat: OutputFormat = this._options.processing.format
    const transcodeEnabled = this._shouldTranscode(outputFormat)

    if (
      outputFormat === 'mp4' &&
      !transcodeEnabled &&
      !this._warnedAboutMp4Compatibility
    ) {
      this._warnedAboutMp4Compatibility = true
      this._log(
        'warn',
        '[WdioPuppeteerVideoService] `outputFormat: mp4` without `transcode.enabled` can produce VP9-in-MP4 artifacts that may not play in all players.',
      )
    }

    const recordingFormat: OutputFormat = transcodeEnabled
      ? 'webm'
      : outputFormat

    return {
      outputFormat,
      outputPath: artifactPaths.getSegmentPath(
        this._options.outputDir,
        this._captureSession.currentTestSlug,
        this._captureSession.currentSegment,
        outputFormat,
      ),
      recordingFormat,
      recordingPath: artifactPaths.getSegmentPath(
        this._options.outputDir,
        this._captureSession.currentTestSlug,
        this._captureSession.currentSegment,
        recordingFormat,
      ),
      transcodeEnabled,
    }
  }

  private async _reserveRecordingOutput(
    output: ReturnType<WdioPuppeteerVideoService['_createRecordingOutput']>,
  ): Promise<ReturnType<WdioPuppeteerVideoService['_createRecordingOutput']>> {
    const recordingPath = await artifactIntegrity.reserveArtifactPath(
      output.recordingPath,
    )
    return {
      ...output,
      recordingPath,
      outputPath: output.transcodeEnabled
        ? replaceFileExtension(recordingPath, output.outputFormat)
        : recordingPath,
    }
  }

  private async _startRecordingForMetadata(
    metadata: Readonly<SlugMetadata>,
    _retryCount: number,
  ): Promise<boolean> {
    if (this._captureSession.currentTestSlug) {
      return true
    }

    this._log(
      'debug',
      `[WdioPuppeteerVideoService] Starting test recording: ${metadata.testNameToken}`,
    )

    const baseSlug = this._buildTestSlugFromMetadata(metadata)
    const slug = reserveUniqueSlug(
      baseSlug,
      this._maxSlugLength,
      this._slugUsageCount,
    )
    this._captureSession.beginRecording(slug)

    return this._startRecording()
  }

  private async _finalizeRecordingMedia(
    passed: boolean,
    keepArtifacts: boolean,
  ): Promise<{ deferred: boolean; paths: readonly string[] }> {
    if (!this._captureSession.currentTestSlug) {
      return { deferred: false, paths: [] }
    }

    const deferredTaskCount = this._deferredPostProcessTasks.length
    await this._recordingLifecycle.finalize({
      stopRecording: async () => {
        await this._stopRecording()
      },
      processArtifacts: async () => {
        this._log(
          'debug',
          `[WdioPuppeteerVideoService] Finished test recording (passed=${passed}, keepArtifacts=${keepArtifacts}).`,
        )
        if (!keepArtifacts) {
          await this._deleteSegments()
          return
        }

        if (this._options.processing.merge.enabled) {
          if (this._shouldDeferPostProcessing()) {
            await this._queueDeferredMergeForCurrentTest()
          } else {
            await this._mergeSegmentsForCurrentTest()
          }
        }
      },
    })

    return {
      deferred: this._deferredPostProcessTasks.length > deferredTaskCount,
      paths: this._captureSession.recordedPaths,
    }
  }

  private async _stopRecording(): Promise<void> {
    let activeSegment: ActiveSegment | undefined
    let streamOk = false
    let recordingSlotReleased = false
    const releaseRecordingSlot = async (): Promise<void> => {
      if (recordingSlotReleased) {
        return
      }
      recordingSlotReleased = true
      await this._recordingSlotScheduler.release()
    }
    const hadWorkAtInvocation = this._captureSession.hasCapture
    await this._recordingLifecycle.stop({
      hasWork: () => this._captureSession.hasCapture,
      stopCapture: async () => {
        const stoppedCapture = await this._captureEngine.stopCapture()
        activeSegment = stoppedCapture.segment
        streamOk = stoppedCapture.streamOk
      },
      processCapture: async () => {
        try {
          if (!activeSegment) {
            return
          }
          if (!streamOk) {
            this._log(
              'warn',
              `[WdioPuppeteerVideoService] Recording stream did not finish cleanly for: ${activeSegment.recordingPath}`,
            )
          }

          await releaseRecordingSlot()
          await this._finalizeSegment(activeSegment)
          this._log(
            'debug',
            `[WdioPuppeteerVideoService] Finalized segment ${this._captureSession.currentSegment} (${activeSegment.outputPath})`,
          )
        } finally {
          await releaseRecordingSlot()
        }
      },
    })

    if (
      !hadWorkAtInvocation &&
      (this._recordingSlotScheduler.ownsRecordingSlot ||
        this._recordingSlotScheduler.ownsGlobalRecordingSlot)
    ) {
      await this._recordingSlotScheduler.release()
    }
  }

  private async _deleteSegments(): Promise<void> {
    const filesToDelete = [...this._captureSession.recordedPaths]
    await Promise.all(
      filesToDelete.map((file) =>
        this._fileSystem.unlink(file).catch(() => {
          /* ignore if file does not exist */
        }),
      ),
    )
    this._dropDeferredPostProcessTasksForPaths(filesToDelete)
    this._captureSession.clearRecordedPaths()
  }

  private async _queueDeferredMergeForCurrentTest(): Promise<void> {
    const currentTestSlug = this._captureSession.currentTestSlug
    if (!currentTestSlug) {
      return
    }

    const segmentPaths = artifactPaths.collectCurrentTestSegmentPaths(
      currentTestSlug,
      this._captureSession.recordedPaths,
    )
    if (segmentPaths.length === 0) {
      return
    }

    const deleteSegments = this._options.processing.merge.deleteSegments
    const mergedFormat = artifactPaths.resolveMergeFormat(
      segmentPaths,
      'deferred merge',
      (message) => {
        this._log('warn', message)
      },
    )
    if (!mergedFormat) {
      return
    }

    const mergeTask = postProcess.createDeferredMergeTask({
      deleteSegments,
      getMergedOutputPath: (format) =>
        artifactPaths.getMergedOutputPath(
          this._options.outputDir,
          currentTestSlug,
          format,
        ),
      mergedFormat,
      outputFormat: this._options.processing.format,
      segmentPaths,
      shouldTranscodeMergedOutput: this._shouldTranscode('mp4'),
      transcodeOptions: this._createResolvedTranscodeOptions(),
    })
    const manifestEntryId = this._manifestRecorder?.currentEntryId
    if (manifestEntryId) {
      mergeTask.manifestEntryId = manifestEntryId
    }

    this._dropDeferredPostProcessTasksForPaths(segmentPaths)
    this._deferredPostProcessTasks.push(mergeTask)
    this._log(
      'debug',
      `[WdioPuppeteerVideoService] Queued deferred merge for ${segmentPaths.length} segments into ${mergeTask.mergedPath}.`,
    )
  }

  private async _mergeSegmentsForCurrentTest(): Promise<void> {
    const currentTestSlug = this._captureSession.currentTestSlug
    if (!currentTestSlug) {
      return
    }

    const segmentPaths = artifactPaths.collectCurrentTestSegmentPaths(
      currentTestSlug,
      this._captureSession.recordedPaths,
    )

    if (segmentPaths.length === 0) {
      return
    }

    const deleteSegments = this._options.processing.merge.deleteSegments
    const mergedFormat = artifactPaths.resolveMergeFormat(
      segmentPaths,
      'merge',
      (message) => {
        this._log('warn', message)
      },
    )
    if (!mergedFormat) {
      return
    }

    const mergedPath = artifactPaths.getMergedOutputPath(
      this._options.outputDir,
      currentTestSlug,
      mergedFormat,
    )
    this._log(
      'debug',
      `[WdioPuppeteerVideoService] Attempting merge for ${segmentPaths.length} segments into ${mergedPath}`,
    )

    const publishedMergedPath = await this._mergeSegmentPathsToOutput({
      segmentPaths,
      mergedPath,
      deleteSegments,
      writeFailureContext: 'merge',
      ffmpegOperation: 'segment merge',
    })
    if (!publishedMergedPath) {
      this._reportPostProcessFailure(
        `Merge failed, keeping ${segmentPaths.length.toString()} original segment(s).`,
      )
      return
    }

    this._captureSession.addRecordedPath(publishedMergedPath)
    if (deleteSegments) {
      for (const segmentPath of segmentPaths) {
        this._captureSession.deleteRecordedPath(segmentPath)
      }
    }
  }

  private async _mergeSegmentPathsToOutput(
    options: MergeExecutionOptions,
  ): Promise<string | undefined> {
    return this._withPostProcessSlot(options.ffmpegOperation, () =>
      postProcess.mergeSegmentPathsToOutput({
        ...options,
        outputDir: this._options.outputDir,
        runFfmpeg: (args, operation) => this._runFfmpeg(args, operation),
        warn: (message) => {
          this._log('warn', message)
        },
      }),
    )
  }

  private _createResolvedTranscodeOptions(): ResolvedTranscodeOptions {
    const configuredFfmpegArgs = this._options.processing.transcode.ffmpegArgs
    const profileFfmpegArgs =
      this._options.profile === 'ci' ? [...CI_TRANSCODE_FFMPEG_ARGS] : undefined
    const ffmpegArgs = configuredFfmpegArgs
      ? [...configuredFfmpegArgs]
      : profileFfmpegArgs

    return {
      deleteOriginal: this._options.processing.transcode.deleteOriginal,
      ...(ffmpegArgs === undefined ? {} : { ffmpegArgs }),
    }
  }

  private _resolveFfmpegPath(): string {
    const configuredPath = this._options.processing.ffmpeg.path?.trim()
    const envPath = this._process.environment('FFMPEG_PATH')?.trim()
    return this._resolvedFfmpegPath || configuredPath || envPath || 'ffmpeg'
  }

  private async _ensureFfmpegReady(): Promise<boolean> {
    if (this._ffmpegAvailable) {
      return true
    }

    if (this._ffmpegInitializationCompleted) {
      return false
    }

    this._ffmpegInitializationTask ??= this._initializeFfmpeg().finally(() => {
      this._ffmpegInitializationCompleted = true
      this._ffmpegInitializationTask = undefined
    })

    return this._ffmpegInitializationTask
  }

  private async _initializeFfmpeg(): Promise<boolean> {
    this._ffmpegCandidates = ffmpeg.getFfmpegCandidates(
      this._options.processing.ffmpeg.path?.trim(),
      this._process.environment('FFMPEG_PATH')?.trim(),
    )
    this._resolvedFfmpegPath = await ffmpeg.resolveAvailableFfmpegPath(
      this._ffmpegCandidates,
    )
    this._ffmpegAvailable = !!this._resolvedFfmpegPath
    const ffmpegPath = this._resolvedFfmpegPath
    if (!this._ffmpegAvailable || !ffmpegPath) {
      this._warnMissingFfmpeg('Video recording is disabled for this worker.')
      return false
    }

    this._log(
      'info',
      `[WdioPuppeteerVideoService] Using ffmpeg binary: ${this._resolvedFfmpegPath}`,
    )
    const ffmpegVersion = await ffmpeg.readFfmpegVersion(ffmpegPath)
    if (ffmpegVersion) {
      await this._manifestRecorder?.noteFfmpegVersion(ffmpegVersion)
    }
    await this._configureMp4RecordingMode()
    return true
  }

  private _shouldTranscode(outputFormat: OutputFormat): boolean {
    if (outputFormat !== 'mp4') {
      return false
    }

    if (this._options.processing.transcode.enabled) {
      return true
    }

    const mode = this._options.processing.mp4Mode
    return mode === 'transcode' || (mode === 'auto' && this._forceMp4Transcode)
  }

  private async _configureMp4RecordingMode(): Promise<void> {
    this._forceMp4Transcode = false

    const outputFormat = this._options.processing.format
    if (outputFormat !== 'mp4') {
      return
    }

    if (this._options.processing.transcode.enabled) {
      return
    }

    const mode = this._options.processing.mp4Mode
    if (mode === 'transcode') {
      this._forceMp4Transcode = true
      this._log(
        'info',
        '[WdioPuppeteerVideoService] MP4 strategy is set to transcode mode.',
      )
      return
    }

    const ffmpegPath = this._resolveFfmpegPath()
    const supportsDirectMp4 =
      (await this._withPostProcessSlot('direct MP4 capability probe', () =>
        ffmpeg.probeDirectMp4Support(ffmpegPath, {
          onProbeFailure: (details) => {
            this._log(
              'debug',
              `[WdioPuppeteerVideoService] Direct MP4 probe failed: ${details}`,
            )
          },
        }),
      )) ?? false
    if (supportsDirectMp4) {
      this._log(
        'info',
        '[WdioPuppeteerVideoService] Detected ffmpeg support for direct MP4 recording.',
      )
      return
    }

    if (mode === 'direct') {
      this._log(
        'warn',
        '[WdioPuppeteerVideoService] MP4 strategy is `direct`, but detected ffmpeg may not support Puppeteer direct MP4 mode. Consider using `mp4Mode: transcode` or `mp4Mode: auto`.',
      )
      return
    }

    this._forceMp4Transcode = true
    if (!this._warnedAboutMp4AutoFallback) {
      this._warnedAboutMp4AutoFallback = true
      this._log(
        'warn',
        '[WdioPuppeteerVideoService] Direct MP4 compatibility probe failed. Falling back to MP4 transcode mode (`mp4Mode: auto`).',
      )
    }
  }

  private async _finalizeSegment(segment: ActiveSegment): Promise<void> {
    const recordedSize = await this._fileSystem
      .stat(segment.recordingPath)
      .then((stats) => stats.size ?? 0)
      .catch(() => 0)

    if (recordedSize === 0) {
      this._log(
        'warn',
        `[WdioPuppeteerVideoService] Recording file is empty: ${segment.recordingPath}`,
      )
      await this._fileSystem.unlink(segment.recordingPath).catch(() => {
        /* best-effort cleanup */
      })
      return
    }

    if (!segment.transcode) {
      this._captureSession.addRecordedPath(segment.outputPath)
      return
    }

    if (this._shouldDeferPostProcessing()) {
      this._captureSession.addRecordedPath(segment.recordingPath)

      if (this._options.processing.merge.enabled) {
        return
      }

      const transcodeTask = postProcess.createDeferredTranscodeTask(
        segment.recordingPath,
        segment.outputPath,
        segment.transcodeOptions,
      )
      const manifestEntryId = this._manifestRecorder?.currentEntryId
      if (manifestEntryId) {
        transcodeTask.manifestEntryId = manifestEntryId
      }
      this._deferredPostProcessTasks.push(transcodeTask)
      this._log(
        'debug',
        `[WdioPuppeteerVideoService] Queued deferred transcode: ${segment.recordingPath} -> ${segment.outputPath}`,
      )
      return
    }

    const transcodedPath = await this._transcodeToH264Mp4(
      segment.recordingPath,
      segment.outputPath,
      segment,
    )
    if (transcodedPath) {
      segment.outputPath = transcodedPath
      this._captureSession.addRecordedPath(transcodedPath)
      if (
        segment.transcodeOptions.deleteOriginal &&
        segment.recordingPath !== segment.outputPath
      ) {
        await this._fileSystem.unlink(segment.recordingPath).catch(() => {
          /* best-effort cleanup */
        })
      }
      return
    }

    this._log(
      'warn',
      `[WdioPuppeteerVideoService] Transcode failed, keeping original recording: ${segment.recordingPath}`,
    )
    this._captureSession.addRecordedPath(segment.recordingPath)
    this._reportPostProcessFailure(
      `Transcode failed, keeping original recording: ${segment.recordingPath}`,
      true,
    )
  }

  private async _transcodeToH264Mp4(
    inputPath: string,
    outputPath: string,
    segment: ActiveSegment,
  ): Promise<string | undefined> {
    return this._transcodeToH264Mp4WithArgs(
      inputPath,
      outputPath,
      segment.transcodeOptions.ffmpegArgs,
    )
  }

  private async _transcodeToH264Mp4WithArgs(
    inputPath: string,
    outputPath: string,
    ffmpegArgs: string[] | undefined,
  ): Promise<string | undefined> {
    return this._withPostProcessSlot('transcode', () =>
      artifactIntegrity.publishAtomicArtifact({
        desiredPath: outputPath,
        process: this._process,
        produce: (temporaryPath) =>
          this._runFfmpeg(
            postProcess.buildH264TranscodeArgs(
              inputPath,
              temporaryPath,
              ffmpegArgs,
            ),
            'transcode',
          ),
        validate: (temporaryPath) =>
          this._runFfmpeg(
            postProcess.buildMediaValidationArgs(temporaryPath),
            'transcode validation',
          ),
        warn: (message) => {
          this._log('warn', message)
        },
      }),
    )
  }

  private async _runFfmpeg(
    args: string[],
    operation: string,
  ): Promise<boolean> {
    return this._runFfmpegProcess(
      {
        args,
        available: this._ffmpegAvailable,
        ffmpegPath: this._resolveFfmpegPath(),
        log: (level, message, details) => {
          this._log(level, message, details)
        },
        markUnavailable: () => {
          this._ffmpegAvailable = false
        },
        operation,
        timeoutMs: this._options.processing.ffmpeg.timeoutMs,
        warnMissing: (reason) => {
          this._warnMissingFfmpeg(reason)
        },
      },
      this._ffmpegProcessRegistry,
    )
  }

  private async _withPostProcessSlot<T>(
    operation: string,
    task: () => Promise<T>,
  ): Promise<T | undefined> {
    const acquired = await this._postProcessSlotScheduler.acquire()
    if (!acquired) {
      const timeout = this._options.concurrency.postProcessStartTimeoutMs
      const message = `Unable to start ${operation} within ${timeout.toString()}ms because post-processing capacity is exhausted.`
      this._log('warn', `[WdioPuppeteerVideoService] ${message}`)
      return undefined
    }

    try {
      return await task()
    } finally {
      await this._postProcessSlotScheduler.release()
    }
  }

  private _reportPostProcessFailure(
    message: string,
    alreadyLogged = false,
  ): void {
    if (!alreadyLogged) {
      this._log('warn', `[WdioPuppeteerVideoService] ${message}`)
    }
    if (this._options.failurePolicy === 'error') {
      throw new Error(`[WdioPuppeteerVideoService] ${message}`)
    }
  }

  private _warnMissingFfmpeg(reason: string): void {
    if (this._warnedAboutMissingFfmpeg) {
      return
    }

    this._warnedAboutMissingFfmpeg = true
    const configuredPath = this._options.processing.ffmpeg.path
      ? `Configured ffmpegPath: ${this._options.processing.ffmpeg.path}.`
      : 'No ffmpegPath was provided.'
    const candidateList =
      this._ffmpegCandidates.length > 0
        ? ` Checked candidates: ${this._ffmpegCandidates.join(', ')}.`
        : ''
    this._log(
      'warn',
      `[WdioPuppeteerVideoService] FFmpeg is required but unavailable. ${configuredPath}${candidateList} Install FFmpeg and make it available on PATH, set \`ffmpegPath\`, or install \`ffmpeg-static\` in your project. ${reason}`,
    )
  }

  private async _runSerializedRecordingTask(
    task: () => Promise<void>,
  ): Promise<void> {
    const wrappedTask = async () => {
      try {
        await task()
      } catch (error) {
        this._log(
          'error',
          '[WdioPuppeteerVideoService] Recording task failed:',
          error,
        )
        if (this._options.failurePolicy === 'error') {
          throw error
        }
      }
    }

    this._recordingTask = this._recordingTask.then(wrappedTask, wrappedTask)
    await this._recordingTask
  }

  private _hasDeferredPostProcessTasks(): boolean {
    return this._deferredPostProcessTasks.length > 0
  }

  private _shouldDeferPostProcessing(): boolean {
    return this._options.processing.timing === 'after-worker'
  }

  private async _flushDeferredPostProcessTasks(): Promise<void> {
    if (!this._hasDeferredPostProcessTasks()) {
      return
    }

    this._log(
      'info',
      `[WdioPuppeteerVideoService] Processing ${this._deferredPostProcessTasks.length} deferred post-processing task(s).`,
    )

    let firstFailure: { error: unknown } | undefined
    while (this._deferredPostProcessTasks.length > 0) {
      const nextTask = this._deferredPostProcessTasks.shift()
      if (!nextTask) {
        break
      }

      try {
        if (nextTask.kind === 'merge') {
          await this._executeDeferredMergeTask(nextTask)
          continue
        }

        await this._executeDeferredTranscodeTask(nextTask)
      } catch (error) {
        firstFailure ??= { error }
        this._log(
          'error',
          `[WdioPuppeteerVideoService] Deferred ${nextTask.kind} task failed:`,
          error,
        )
      }
    }

    if (firstFailure) {
      throw firstFailure.error
    }
  }

  private async _executeDeferredTranscodeTask(
    task: DeferredTranscodeTask,
  ): Promise<void> {
    const inputExists = await this._fileSystem
      .stat(task.inputPath)
      .then(() => true)
      .catch(() => false)
    if (!inputExists) {
      if (task.manifestEntryId) {
        await this._manifestRecorder?.completeDeferred(task.manifestEntryId, {
          decision: 'failed',
          paths: [task.inputPath],
          reason: 'deferred-transcode-input-missing',
          processingOutcome: 'failed',
          processingOperation: 'transcode',
        })
      }
      return
    }

    const transcodedPath = await this._transcodeToH264Mp4WithArgs(
      task.inputPath,
      task.outputPath,
      task.ffmpegArgs,
    )
    if (!transcodedPath) {
      if (task.manifestEntryId) {
        await this._manifestRecorder?.completeDeferred(task.manifestEntryId, {
          decision: 'recorded',
          paths: [task.inputPath],
          reason: 'deferred-transcode-failed-original-preserved',
          processingOutcome: 'failed',
          processingOperation: 'transcode',
        })
      }
      this._reportPostProcessFailure(
        `Deferred transcode failed, keeping original recording: ${task.inputPath}`,
      )
      return
    }

    if (task.deleteOriginal && task.inputPath !== transcodedPath) {
      await this._fileSystem.unlink(task.inputPath).catch(() => {
        /* best-effort cleanup */
      })
    }
    if (task.manifestEntryId) {
      await this._manifestRecorder?.completeDeferred(task.manifestEntryId, {
        decision: 'recorded',
        paths: [transcodedPath],
        processingOutcome: 'completed',
        processingOperation: 'transcode',
      })
    }
  }

  private async _executeDeferredMergeTask(
    task: DeferredMergeTask,
  ): Promise<void> {
    const mergedPath = await this._mergeSegmentPathsToOutput({
      segmentPaths: task.segmentPaths,
      mergedPath: task.mergedPath,
      deleteSegments: task.deleteSegments,
      writeFailureContext: 'deferred merge',
      ffmpegOperation: 'deferred segment merge',
    })
    if (!mergedPath) {
      if (task.manifestEntryId) {
        await this._manifestRecorder?.completeDeferred(task.manifestEntryId, {
          decision: 'recorded',
          paths: task.segmentPaths,
          reason: 'deferred-merge-failed-segments-preserved',
          processingOutcome: 'failed',
          processingOperation: 'merge',
        })
      }
      this._reportPostProcessFailure(
        `Deferred merge failed, keeping ${task.segmentPaths.length.toString()} original segment(s).`,
      )
      return
    }

    if (!task.transcodeToMp4) {
      if (task.manifestEntryId) {
        await this._manifestRecorder?.completeDeferred(task.manifestEntryId, {
          decision: 'recorded',
          paths: [mergedPath],
          processingOutcome: 'completed',
          processingOperation: 'merge',
        })
      }
      return
    }

    const transcodeTask: DeferredTranscodeTask = {
      kind: 'transcode',
      inputPath: mergedPath,
      outputPath: task.transcodeToMp4.outputPath,
      deleteOriginal: task.transcodeToMp4.deleteOriginal,
    }
    if (task.transcodeToMp4.ffmpegArgs !== undefined) {
      transcodeTask.ffmpegArgs = task.transcodeToMp4.ffmpegArgs
    }
    if (task.manifestEntryId) {
      transcodeTask.manifestEntryId = task.manifestEntryId
    }
    await this._executeDeferredTranscodeTask(transcodeTask)
  }

  private _dropDeferredPostProcessTasksForPaths(paths: string[]): void {
    if (paths.length === 0 || this._deferredPostProcessTasks.length === 0) {
      return
    }

    const blockedPaths = new Set(paths)
    const filteredTasks = this._deferredPostProcessTasks.filter((task) => {
      if (task.kind === 'transcode') {
        return (
          !blockedPaths.has(task.inputPath) &&
          !blockedPaths.has(task.outputPath)
        )
      }

      if (blockedPaths.has(task.mergedPath)) {
        return false
      }
      if (
        task.segmentPaths.some((segmentPath) => blockedPaths.has(segmentPath))
      ) {
        return false
      }
      if (
        task.transcodeToMp4 &&
        blockedPaths.has(task.transcodeToMp4.outputPath)
      ) {
        return false
      }

      return true
    })

    this._deferredPostProcessTasks.length = 0
    this._deferredPostProcessTasks.push(...filteredTasks)
  }

  private _log(level: LogLevel, message: string, details?: unknown): void {
    this._writeLog(this._logLevel, level, message, details)
  }

  private _canUseRecordingHooks(): boolean {
    return (
      this._isChromium &&
      !!this._captureSession.browser &&
      this._recordingDisabledReason === undefined
    )
  }

  private _disableRecordingForWorker(reason: string): void {
    if (this._recordingDisabledReason !== undefined) {
      return
    }
    this._recordingDisabledReason = reason
    this._log(
      'warn',
      `[WdioPuppeteerVideoService] Recording disabled for this worker: ${reason}.`,
    )
  }

  private async _resetTestState(): Promise<void> {
    await this._recordingLifecycle.reset(async () => {
      await this._captureEngine.resetRecording()
      await this._recordingSlotScheduler.release()
    })
  }

  /** @internal Exposed for unit testing only. */
  private _buildTestSlug(test: Frameworks.Test, context?: unknown): string {
    const metadata = collectSlugMetadata(
      test,
      context,
      this._options.artifacts.naming.style,
    )
    return this._buildTestSlugFromMetadata(metadata)
  }

  private _buildTestSlugFromMetadata(metadata: SlugMetadata): string {
    return buildTestSlugFromMetadata(metadata, {
      maxSlugLength: this._maxSlugLength,
      fileNameStyle: this._options.artifacts.naming.style,
      fileNameOverflowStrategy: this._options.artifacts.naming.overflow,
      sessionIdToken: this._sessionIdToken,
      sessionIdFullToken: this._sessionIdFullToken,
    })
  }
}
