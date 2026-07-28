import path from 'node:path'
import { finished } from 'node:stream/promises'
import type { Frameworks, Services } from '@wdio/types'
import type {
  Page,
  Browser as PuppeteerBrowser,
  ScreenRecorder,
} from 'puppeteer-core'
import type { Browser } from 'webdriverio'
import * as artifactIntegrity from './service/artifact-integrity.js'
import type {
  ClockBoundary,
  FileSystemBoundary,
  ProcessBoundary,
} from './service/boundaries.js'
import * as capture from './service/capture.js'
import {
  createWorkerCompositionRoot,
  type PuppeteerConnector,
  type ScreencastStarter,
  type UuidFactory,
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
  RECORDER_STOP_TIMEOUT_MS,
  type ResolvedTranscodeOptions,
  SEGMENT_SWITCH_DELAY_MS,
  WINDOW_SEGMENT_COMMANDS,
  WRITE_STREAM_TIMEOUT_MS,
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
  type ManifestCaptureDimensions,
  ManifestWorkerRecorder,
  normalizeManifestFramework,
  readManifestRunContext,
  readManifestWorkerContext,
} from './service/manifest-runtime.js'
import * as normalization from './service/normalization.js'
import { resolveServiceConfiguration } from './service/options.js'
import * as pageLookup from './service/page-lookup.js'
import * as artifactPaths from './service/paths.js'
import * as postProcess from './service/post-process.js'
import {
  classifySessionProtocol,
  describePuppeteerConnectionFailure,
  isChromiumSession,
  type SessionProtocol,
} from './service/protocol.js'
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
  private _browser: Browser | undefined
  private readonly _options: ResolvedWdioPuppeteerVideoServiceOptions
  private readonly _clock: ClockBoundary
  private readonly _fileSystem: FileSystemBoundary
  private readonly _process: ProcessBoundary
  private readonly _uuid: UuidFactory
  private readonly _connectPuppeteer: PuppeteerConnector
  private readonly _startScreencast: ScreencastStarter
  private readonly _runFfmpegProcess: WorkerFfmpegRunner
  private readonly _writeLog: typeof logging.writeLog
  private _recorder: ScreenRecorder | undefined
  private _activeSegment: ActiveSegment | undefined
  private _currentSegment = 0
  private _currentTestSlug = ''
  private readonly _recordedSegments = new Set<string>()
  private _isChromium = false
  private _puppeteerBrowser: PuppeteerBrowser | undefined
  private _sessionProtocol: SessionProtocol = 'unsupported'
  private _recordingDisabledReason: string | undefined
  private _currentWindowHandle: string | undefined
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
  private _pageMarkerCounter = 0
  private _manifestRecorder: ManifestWorkerRecorder | undefined
  private _manifestCaptureDimensions: ManifestCaptureDimensions | undefined
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
    this._uuid = composition.uuid
    this._connectPuppeteer = composition.connectPuppeteer
    this._startScreencast = composition.startScreencast
    this._runFfmpegProcess = composition.runFfmpeg
    this._writeLog = composition.writeLog
    this._ffmpegProcessRegistry = composition.createFfmpegProcessRegistry()
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
        getRecordedPaths: () => [...this._recordedSegments],
        isRecordingActive: () => this._isRecordingActive(),
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
    this._browser = browser
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
    this._puppeteerBrowser = undefined
    this._sessionProtocol = 'unsupported'
    const browserVersion = caps.browserVersion
    const browserName = caps.browserName
    this._manifestRecorder?.configureSession({
      sessionId: browser.sessionId,
      ...(typeof browserName === 'string' ? { browserName } : {}),
      ...(typeof browserVersion === 'string' ? { browserVersion } : {}),
      protocol: this._sessionProtocol,
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
      this._browser = undefined
      this._isChromium = false
      this._puppeteerBrowser = undefined
      this._sessionProtocol = 'unsupported'
    }
    if (failure) {
      throw failure.error
    }
  }

  async onReload(oldSessionId: string, newSessionId: string): Promise<void> {
    await this._teardownRecording('onReload')
    this._puppeteerBrowser = undefined
    this._sessionProtocol = 'unsupported'
    this._sessionIdToken = buildSessionIdToken(newSessionId)
    this._sessionIdFullToken = buildFullSessionIdToken(newSessionId)
    const capabilities = this._browser?.capabilities as
      | WebdriverIO.Capabilities
      | undefined
    const browserVersion = capabilities?.browserVersion
    const browserName = capabilities?.browserName
    this._manifestRecorder?.configureSession({
      sessionId: newSessionId,
      ...(typeof browserName === 'string' ? { browserName } : {}),
      ...(typeof browserVersion === 'string' ? { browserVersion } : {}),
      protocol: 'unsupported',
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
        if (this._isRecordingActive()) {
          if (this._recordingCoordinator.isSpecScope && this._currentTestSlug) {
            await this._recordingCoordinator.finalizeSpecRecording()
          } else {
            await this._stopRecording()
            await this._resetTestState()
          }
        }

        await this._flushDeferredPostProcessTasks()
      } finally {
        if (
          this._isRecordingActive() ||
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

    if (!this._currentTestSlug) {
      return
    }

    if (this._options.recording.windowChanges !== 'segment') {
      return
    }

    if (commandName === 'closeWindow') {
      await this._runSerializedRecordingTask(async () => {
        await this._stopRecording()
      })
    }
  }

  async afterCommand(commandName: string): Promise<void> {
    if (!this._canUseRecordingHooks()) {
      return
    }

    if (!this._currentTestSlug) {
      return
    }

    if (this._options.recording.windowChanges !== 'segment') {
      return
    }

    if (!WINDOW_SEGMENT_COMMANDS.has(commandName)) {
      return
    }

    await this._runSerializedRecordingTask(async () => {
      if (!this._browser) {
        return
      }

      if (commandName === 'closeWindow') {
        const handleAfterClose = await this._browser
          .getWindowHandle()
          .catch(() => undefined /* window may already be closed */)
        if (!handleAfterClose) {
          this._currentWindowHandle = undefined
          return
        }

        this._currentSegment++
        await this._clock.delay(SEGMENT_SWITCH_DELAY_MS)
        await this._startRecording()
        return
      }

      const handle = await this._browser
        .getWindowHandle()
        .catch(() => undefined /* window may already be closed */)

      if (!handle || this._currentWindowHandle === handle) {
        return
      }

      await this._stopRecording()
      this._currentSegment++
      await this._startRecording()
    })
  }

  private async _startRecording(): Promise<boolean> {
    if (!this._browser || !this._currentTestSlug || this._recorder) {
      return false
    }

    return this._recordingLifecycle.start(async () => {
      return this._startRecordingOperation()
    })
  }

  private async _startRecordingOperation(): Promise<boolean> {
    const browser = this._browser
    if (!browser || !this._currentTestSlug) {
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

    let pendingRecorder: ScreenRecorder | undefined
    let pendingSegment: ActiveSegment | undefined
    let pendingRecordingPath: string | undefined
    try {
      const activePage = await this._prepareRecordingPage(browser)
      if (!activePage) {
        return false
      }

      const { page, windowHandle } = activePage
      this._manifestCaptureDimensions = await capture.resolveCaptureDimensions(
        page,
        this._options.capture,
      )
      const recordingOutput = await this._reserveRecordingOutput(
        this._createRecordingOutput(),
      )
      pendingRecordingPath = recordingOutput.recordingPath

      const ffmpegPath = this._resolveFfmpegPath()
      const recorder = await this._startScreencast(page, {
        capture: this._options.capture,
        ffmpegPath,
        format: recordingOutput.recordingFormat,
        onViewportRestoreError: (error) => {
          this._log(
            'warn',
            `[WdioPuppeteerVideoService] Failed to restore the browser viewport after capture initialization: ${normalization.describeError(error)}`,
          )
        },
      })
      pendingRecorder = recorder

      const writeStream = this._fileSystem.createWriteStream(
        recordingOutput.recordingPath,
        'r+',
      )
      const writeStreamDone = finished(writeStream)
      let activeSegmentRef: ActiveSegment | undefined
      const onWriteStreamError = (error: NodeJS.ErrnoException) => {
        if (activeSegmentRef?.writeStreamErrored) {
          return
        }
        const writeErrorMessage = normalization.describeError(error)
        if (activeSegmentRef) {
          activeSegmentRef.writeStreamErrored = true
          activeSegmentRef.writeStreamErrorMessage = writeErrorMessage
        }
        if (normalization.isBenignStreamWriteError(error)) {
          this._log(
            'debug',
            `[WdioPuppeteerVideoService] Recording stream closed while recorder was still flushing (${writeErrorMessage}).`,
          )
        } else {
          this._log(
            'warn',
            `[WdioPuppeteerVideoService] Recording stream error: ${writeErrorMessage}`,
          )
        }
      }
      let recorderErrorLogged = false
      const onRecorderError = (error: unknown) => {
        if (recorderErrorLogged) {
          return
        }
        recorderErrorLogged = true
        this._log(
          'warn',
          `[WdioPuppeteerVideoService] Recorder stream error: ${normalization.describeError(error)}`,
        )
      }
      writeStream.on('error', onWriteStreamError)
      recorder.on('error', onRecorderError)

      const transcodeOptions = this._createResolvedTranscodeOptions()
      pendingSegment = {
        recordingPath: recordingOutput.recordingPath,
        outputPath: recordingOutput.outputPath,
        outputFormat: recordingOutput.outputFormat,
        recordingFormat: recordingOutput.recordingFormat,
        transcode: recordingOutput.transcodeEnabled,
        transcodeOptions,
        writeStream,
        writeStreamDone,
        writeStreamErrored: false,
        onWriteStreamError,
        onRecorderError,
      }
      activeSegmentRef = pendingSegment
      recorder.pipe(writeStream)

      this._currentWindowHandle = windowHandle
      this._log(
        'debug',
        `[WdioPuppeteerVideoService] Recording segment ${this._currentSegment} to ${recordingOutput.outputPath}`,
      )

      await this._kickOffScreencastFramesIfEnabled(page)
      this._recorder = recorder
      this._activeSegment = pendingSegment
      this._manifestRecorder?.markCaptureStarted(
        this._manifestCaptureDimensions,
      )
      pendingRecorder = undefined
      pendingSegment = undefined
      pendingRecordingPath = undefined
      return true
    } catch (e) {
      this._log(
        'error',
        '[WdioPuppeteerVideoService] Failed to start recording:',
        e,
      )
      await this._cleanupPartialRecording(pendingRecorder, pendingSegment)
      if (pendingRecordingPath) {
        await this._fileSystem.unlink(pendingRecordingPath).catch(() => {
          /* best-effort exclusive-reservation cleanup */
        })
      }
      return false
    } finally {
      if (acquiredRecordingSlot && !this._recorder) {
        await this._recordingSlotScheduler.release()
      }
    }
  }

  private async _cleanupPartialRecording(
    recorder: ScreenRecorder | undefined,
    segment: ActiveSegment | undefined,
  ): Promise<void> {
    if (recorder) {
      await this._stopRecorder(recorder)
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
    await this._waitForWriteStreamCompletion(segment)
    await this._fileSystem.unlink(segment.recordingPath).catch(() => {
      /* best-effort partial recording cleanup */
    })
  }

  private async _stopRecorder(recorder: ScreenRecorder): Promise<void> {
    let timeout: NodeJS.Timeout | undefined
    const timeoutTask = new Promise<never>((_resolve, reject) => {
      timeout = this._clock.setTimeout(() => {
        reject(
          new Error(
            `Recorder stop timed out after ${RECORDER_STOP_TIMEOUT_MS.toString()}ms`,
          ),
        )
      }, RECORDER_STOP_TIMEOUT_MS)
      timeout.unref?.()
    })

    try {
      await Promise.race([recorder.stop(), timeoutTask])
    } catch (error) {
      this._log(
        'warn',
        '[WdioPuppeteerVideoService] Error stopping recorder:',
        error,
      )
      if (!recorder.destroyed) {
        recorder.destroy()
      }
    } finally {
      if (timeout) {
        this._clock.clearTimeout(timeout)
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

  private async _prepareRecordingPage(browser: Browser): Promise<
    | {
        page: Page
        windowHandle: string | undefined
      }
    | undefined
  > {
    const puppeteerBrowser = await this._getPuppeteerBrowser(browser)
    if (!puppeteerBrowser) {
      return undefined
    }
    const windowHandle = await browser
      .getWindowHandle()
      .catch(() => undefined /* window may already be closed */)

    const targetId = this._nextPageMarkerId()
    await browser.execute(
      (property: string, id: string) => {
        Object.defineProperty(globalThis, property, {
          configurable: true,
          enumerable: false,
          value: id,
          writable: false,
        })
      },
      pageLookup.PAGE_MARKER_PROPERTY,
      targetId,
    )

    const page = await pageLookup
      .findActivePage(puppeteerBrowser, targetId, { clock: this._clock })
      .finally(async () => {
        await browser
          .execute(
            (property: string, id: string) => {
              if (Reflect.get(globalThis, property) === id) {
                Reflect.deleteProperty(globalThis, property)
              }
            },
            pageLookup.PAGE_MARKER_PROPERTY,
            targetId,
          )
          .catch(() => {
            /* best-effort marker cleanup during navigation or target closure */
          })
      })
    if (!page) {
      this._log(
        'warn',
        '[WdioPuppeteerVideoService] Could not find puppeteer page match. Recording skipped.',
      )
      return undefined
    }

    await page.bringToFront().catch(() => {
      /* best-effort focus */
    })

    return {
      page,
      windowHandle,
    }
  }

  private async _getPuppeteerBrowser(
    browser: Browser,
  ): Promise<PuppeteerBrowser | undefined> {
    if (this._puppeteerBrowser && this._puppeteerBrowser.connected !== false) {
      return this._puppeteerBrowser
    }

    try {
      const puppeteerBrowser = await this._connectPuppeteer(
        browser,
        this._options.capture.connectionTimeoutMs,
      )
      this._puppeteerBrowser = puppeteerBrowser
      this._sessionProtocol = classifySessionProtocol(
        browser.capabilities,
        true,
      )
      this._manifestRecorder?.updateProtocol(this._sessionProtocol)
      this._log(
        'info',
        `[WdioPuppeteerVideoService] Session protocol classified as ${this._sessionProtocol}: WDIO controls the browser through ${this._sessionProtocol === 'bidi+cdp' ? 'WebDriver BiDi' : 'classic WebDriver'}, while Puppeteer capture attaches through CDP.`,
      )
      return puppeteerBrowser
    } catch (error) {
      this._puppeteerBrowser = undefined
      this._sessionProtocol = 'unsupported'
      this._disableRecordingForWorker(
        describePuppeteerConnectionFailure(browser, error),
      )
      return undefined
    }
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
        this._currentTestSlug,
        this._currentSegment,
        outputFormat,
      ),
      recordingFormat,
      recordingPath: artifactPaths.getSegmentPath(
        this._options.outputDir,
        this._currentTestSlug,
        this._currentSegment,
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
    if (this._currentTestSlug) {
      return true
    }

    this._log(
      'debug',
      `[WdioPuppeteerVideoService] Starting test recording: ${metadata.testNameToken}`,
    )

    const baseSlug = this._buildTestSlugFromMetadata(metadata)
    this._currentTestSlug = reserveUniqueSlug(
      baseSlug,
      this._maxSlugLength,
      this._slugUsageCount,
    )
    this._currentSegment = 1
    this._recordedSegments.clear()
    this._currentWindowHandle = undefined
    this._activeSegment = undefined

    return this._startRecording()
  }

  private async _finalizeRecordingMedia(
    passed: boolean,
    keepArtifacts: boolean,
  ): Promise<{ deferred: boolean; paths: readonly string[] }> {
    if (!this._currentTestSlug) {
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
      paths: [...this._recordedSegments],
    }
  }

  private async _stopRecording(): Promise<void> {
    let recorder: ScreenRecorder | undefined
    let activeSegment: ActiveSegment | undefined
    let recordingSlotReleased = false
    const releaseRecordingSlot = async (): Promise<void> => {
      if (recordingSlotReleased) {
        return
      }
      recordingSlotReleased = true
      await this._recordingSlotScheduler.release()
    }
    const hadWorkAtInvocation = !!this._recorder || !!this._activeSegment
    await this._recordingLifecycle.stop({
      hasWork: () => !!this._recorder || !!this._activeSegment,
      stopCapture: async () => {
        recorder = this._recorder
        activeSegment = this._activeSegment
        this._recorder = undefined
        this._activeSegment = undefined
        if (recorder) {
          await this._stopRecorder(recorder)
        }
      },
      processCapture: async () => {
        try {
          if (!recorder || !activeSegment) {
            if (recorder && !recorder.destroyed) {
              recorder.destroy()
            }
            await this._cleanupPartialRecording(undefined, activeSegment)
            return
          }

          const streamOk = await this._waitForWriteStream(activeSegment)
          if (!streamOk) {
            this._log(
              'warn',
              `[WdioPuppeteerVideoService] Recording stream did not finish cleanly for: ${activeSegment.recordingPath}`,
            )
            this._markSegmentAsUnclean(activeSegment)
          }

          await releaseRecordingSlot()
          await this._finalizeSegment(activeSegment)
          this._log(
            'debug',
            `[WdioPuppeteerVideoService] Finalized segment ${this._currentSegment} (${activeSegment.outputPath})`,
          )
        } finally {
          if (recorder && activeSegment) {
            recorder.off('error', activeSegment.onRecorderError)
            activeSegment.writeStream.off(
              'error',
              activeSegment.onWriteStreamError,
            )
          }
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
    const filesToDelete = [...this._recordedSegments]
    await Promise.all(
      filesToDelete.map((file) =>
        this._fileSystem.unlink(file).catch(() => {
          /* ignore if file does not exist */
        }),
      ),
    )
    this._dropDeferredPostProcessTasksForPaths(filesToDelete)
    this._recordedSegments.clear()
  }

  private async _queueDeferredMergeForCurrentTest(): Promise<void> {
    if (!this._currentTestSlug) {
      return
    }

    const segmentPaths = artifactPaths.collectCurrentTestSegmentPaths(
      this._currentTestSlug,
      this._recordedSegments,
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
          this._currentTestSlug,
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
    if (!this._currentTestSlug) {
      return
    }

    const segmentPaths = artifactPaths.collectCurrentTestSegmentPaths(
      this._currentTestSlug,
      this._recordedSegments,
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
      this._currentTestSlug,
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

    this._recordedSegments.add(publishedMergedPath)
    if (deleteSegments) {
      for (const segmentPath of segmentPaths) {
        this._recordedSegments.delete(segmentPath)
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

  private async _kickOffScreencastFrames(page: Page): Promise<void> {
    await capture.primeScreencastFrames(page, this._clock)
  }

  private async _kickOffScreencastFramesIfEnabled(page: Page): Promise<void> {
    if (!this._options.capture.framePriming) {
      return
    }

    await this._kickOffScreencastFrames(page)
  }

  private async _waitForWriteStream(segment: ActiveSegment): Promise<boolean> {
    if (segment.writeStreamErrored) {
      await this._waitForWriteStreamCompletion(segment)
      return false
    }

    const ok = await Promise.race([
      segment.writeStreamDone.then(() => true).catch(() => false),
      this._createWriteStreamTimeout(),
    ])

    if (!ok) {
      this._log(
        'warn',
        `[WdioPuppeteerVideoService] Timed out waiting for recording stream to finish: ${segment.recordingPath}`,
      )
      await this._destroyTimedOutWriteStream(segment)
      return false
    }

    return true
  }

  private async _createWriteStreamTimeout(): Promise<false> {
    await this._clock.delay(WRITE_STREAM_TIMEOUT_MS)
    return false
  }

  private _markSegmentAsUnclean(segment: ActiveSegment): void {
    segment.transcode = false
    segment.outputPath = segment.recordingPath
    segment.outputFormat = segment.recordingFormat
  }

  private async _waitForWriteStreamCompletion(
    segment: Pick<ActiveSegment, 'writeStreamDone'>,
  ): Promise<void> {
    await segment.writeStreamDone.catch(() => {
      /* already errored */
    })
  }

  private async _destroyTimedOutWriteStream(
    segment: Pick<
      ActiveSegment,
      | 'recordingPath'
      | 'writeStream'
      | 'writeStreamDone'
      | 'writeStreamErrored'
      | 'writeStreamErrorMessage'
    >,
  ): Promise<void> {
    const timeoutMessage = `Timed out waiting for recording stream to finish: ${segment.recordingPath}`
    segment.writeStreamErrored = true
    segment.writeStreamErrorMessage = timeoutMessage

    if (!segment.writeStream.destroyed) {
      segment.writeStream.destroy(new Error(timeoutMessage))
    }

    await this._waitForWriteStreamCompletion(segment)
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
      this._recordedSegments.add(segment.outputPath)
      return
    }

    if (this._shouldDeferPostProcessing()) {
      this._recordedSegments.add(segment.recordingPath)

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
      this._recordedSegments.add(transcodedPath)
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
    this._recordedSegments.add(segment.recordingPath)
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
      !!this._browser &&
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
      this._recorder = undefined
      this._activeSegment = undefined
      this._currentSegment = 0
      this._currentTestSlug = ''
      this._currentWindowHandle = undefined
      this._manifestCaptureDimensions = undefined
      this._recordedSegments.clear()
      await this._recordingSlotScheduler.release()
    })
  }

  private _isRecordingActive(): boolean {
    return !!this._currentTestSlug || !!this._recorder || !!this._activeSegment
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

  private _nextPageMarkerId(): string {
    this._pageMarkerCounter += 1
    const sessionToken =
      this._sessionIdToken || this._sessionIdFullToken || 'session'
    return `wdio-video-${sessionToken}-${this._pageMarkerCounter.toString(36)}-${this._uuid()}`
  }
}
