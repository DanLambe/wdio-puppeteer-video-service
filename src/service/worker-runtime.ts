import type { Frameworks, Services } from '@wdio/types'
import type { Browser } from 'webdriverio'
import type {
  LogLevel,
  ResolvedWdioPuppeteerVideoServiceOptions,
  WdioPuppeteerVideoServiceOptions,
} from '../types.js'
import { buildSessionIdToken } from '../video-name-utils.js'
import type { FileSystemBoundary } from './boundaries.js'
import { CaptureSession } from './capture-session.js'
import {
  createWorkerCompositionRoot,
  type WorkerCompositionOverrides,
} from './composition.js'
import { FfmpegRuntime } from './ffmpeg-runtime.js'
import {
  createLauncherRegistrationError,
  inspectLauncherWorkerContext,
  type LauncherWorkerContext,
} from './launcher-context.js'
import * as logging from './logging.js'
import {
  hasManifestWorkerContexts,
  ManifestWorkerRecorder,
  normalizeManifestFramework,
  readManifestRunContext,
  readManifestWorkerContext,
} from './manifest-runtime.js'
import { MediaPipeline } from './media-pipeline.js'
import * as normalization from './normalization.js'
import { resolveServiceConfiguration } from './options.js'
import { isChromiumSession } from './protocol.js'
import { PuppeteerCaptureEngine } from './puppeteer-capture-engine.js'
import { RecordingController } from './recording-controller.js'
import {
  normalizeScenarioEntity,
  normalizeScenarioOutcome,
  normalizeTestEntity,
  normalizeTestOutcome,
} from './recording-entity.js'
import { RecordingMediaCoordinator } from './recording-media-coordinator.js'
import type { WorkerRecordingCoordinatorPort } from './worker-recording-coordinator.js'

const validateLauncherWorkerConfiguration = (
  config: unknown,
): LauncherWorkerContext => {
  const launcherContext = inspectLauncherWorkerContext(config)
  if (launcherContext.status !== 'valid') {
    throw createLauncherRegistrationError(launcherContext.status)
  }
  if (!hasManifestWorkerContexts(config)) {
    throw createLauncherRegistrationError('malformed')
  }
  if (
    launcherContext.context.manifestContextAvailable &&
    readManifestRunContext(config)?.runId !== launcherContext.context.runId
  ) {
    throw createLauncherRegistrationError('malformed')
  }
  return launcherContext.context
}

/**
 * WebdriverIO Service to record videos using Puppeteer and FFmpeg
 */
export class WdioPuppeteerVideoWorkerRuntime
  implements Services.ServiceInstance
{
  private readonly _options: ResolvedWdioPuppeteerVideoServiceOptions
  private readonly _fileSystem: FileSystemBoundary
  private readonly _writeLog: typeof logging.writeLog
  private readonly _captureSession: CaptureSession
  private readonly _captureEngine: PuppeteerCaptureEngine
  private readonly _ffmpegRuntime: FfmpegRuntime
  private readonly _mediaCoordinator: RecordingMediaCoordinator
  private readonly _recordingController: RecordingController
  private _isChromium = false
  private _recordingDisabledReason: string | undefined
  private _logLevel: LogLevel = 'warn'
  private readonly _hasExplicitLogLevel: boolean
  private _teardownTask: Promise<void> | undefined
  private _manifestRecorder: ManifestWorkerRecorder | undefined
  private readonly _recordingCoordinator: WorkerRecordingCoordinatorPort

  constructor(
    options: WdioPuppeteerVideoServiceOptions = {},
    _capabilities?: unknown,
    config?: unknown,
    compositionOverrides?: WorkerCompositionOverrides,
  ) {
    const launcherContext =
      config === undefined
        ? undefined
        : validateLauncherWorkerConfiguration(config)
    const resolvedConfiguration = resolveServiceConfiguration(options)
    this._hasExplicitLogLevel = resolvedConfiguration.hasExplicitLogLevel
    this._logLevel = resolvedConfiguration.logLevel
    this._options = resolvedConfiguration.options
    const composition = createWorkerCompositionRoot(compositionOverrides)
    this._fileSystem = composition.fileSystem
    this._writeLog = composition.writeLog
    this._captureSession = new CaptureSession()
    let recordingController: RecordingController | undefined
    this._captureEngine = new PuppeteerCaptureEngine({
      capture: this._options.capture,
      clock: composition.clock,
      connectPuppeteer: composition.connectPuppeteer,
      fileSystem: this._fileSystem,
      getSessionToken: () => recordingController?.sessionIdToken ?? '',
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
    const recordingSlotScheduler = composition.createRecordingSlotScheduler(
      this._options,
      (level, message, details) => {
        this._log(level, message, details)
      },
      launcherContext?.runId,
    )
    const ffmpegProcessRegistry = composition.createFfmpegProcessRegistry()
    this._ffmpegRuntime = new FfmpegRuntime({
      createPostProcessSlotScheduler: () =>
        composition.createPostProcessSlotScheduler(
          this._options,
          (level, message, details) => {
            this._log(level, message, details)
          },
          launcherContext?.runId,
        ),
      log: (level, message, details) => {
        this._log(level, message, details)
      },
      onVersion: async (version) => {
        await this._manifestRecorder?.noteFfmpegVersion(version)
      },
      options: this._options,
      process: composition.process,
      processRegistry: ffmpegProcessRegistry,
      runFfmpeg: composition.runFfmpeg,
    })
    const mediaPipeline = new MediaPipeline({
      failurePolicy: this._options.failurePolicy,
      fileSystem: this._fileSystem,
      log: (level, message, details) => {
        this._log(level, message, details)
      },
      outputDir: this._options.outputDir,
      process: composition.process,
      runtime: this._ffmpegRuntime,
    })
    this._mediaCoordinator = new RecordingMediaCoordinator({
      captureSession: this._captureSession,
      ffmpegRuntime: this._ffmpegRuntime,
      fileSystem: this._fileSystem,
      getManifestRecorder: () => this._manifestRecorder,
      log: (level, message, details) => {
        this._log(level, message, details)
      },
      mediaPipeline,
      options: this._options,
    })
    this._recordingController = new RecordingController({
      captureEngine: this._captureEngine,
      captureSession: this._captureSession,
      ffmpegRuntime: this._ffmpegRuntime,
      getManifestRecorder: () => this._manifestRecorder,
      log: (level, message, details) => {
        this._log(level, message, details)
      },
      maxSlugLength: resolvedConfiguration.maxSlugLength,
      media: this._mediaCoordinator,
      options: this._options,
      recordingSlotScheduler,
    })
    recordingController = this._recordingController
    this._recordingCoordinator = composition.createRecordingCoordinator({
      actions: {
        finalizeMedia: (passed, keepArtifacts) =>
          this._recordingController.finalizeMedia(passed, keepArtifacts),
        getAvailability: () => ({
          available: this._canUseRecordingHooks(),
          ...(this._recordingDisabledReason
            ? { reason: this._recordingDisabledReason }
            : {}),
        }),
        getRecordedPaths: () => this._captureSession.recordedPaths,
        isRecordingActive: () => this._captureSession.isRecordingActive,
        resetRecording: () => this._recordingController.reset(),
        runSerialized: (task) => this._recordingController.runSerialized(task),
        startRecording: (metadata, retryCount) =>
          this._recordingController.startForMetadata(metadata, retryCount),
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
          readDimensions: (filePath) =>
            this._ffmpegRuntime.readMediaDimensions(filePath),
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

    this._recordingController.setSessionId(browser.sessionId)
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
    this._ffmpegRuntime.resetForSession()

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
    this._ffmpegRuntime.resumeAfterTeardown()
    this._captureEngine.resetConnection()
    this._recordingController.setSessionId(newSessionId)
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
      `[WdioPuppeteerVideoService] Reset recording lifecycle for session reload ${buildSessionIdToken(oldSessionId)} -> ${this._recordingController.sessionIdToken}.`,
    )
  }

  private async _teardownRecording(
    source: 'after' | 'afterSession' | 'onReload',
  ): Promise<void> {
    if (this._teardownTask) {
      await this._teardownTask
      return
    }

    const task = this._performRecordingTeardown(source)
    this._teardownTask = task
    try {
      await task
    } finally {
      if (this._teardownTask === task) {
        this._teardownTask = undefined
      }
    }
  }

  private async _performRecordingTeardown(
    source: 'after' | 'afterSession' | 'onReload',
  ): Promise<void> {
    await this._ffmpegRuntime.terminateAll()
    try {
      await this._recordingController.runSerialized(async () => {
        this._ffmpegRuntime.resumeAfterTeardown()
        try {
          if (this._captureSession.isRecordingActive) {
            if (
              this._recordingCoordinator.isSpecScope &&
              this._captureSession.currentTestSlug
            ) {
              await this._recordingCoordinator.finalizeSpecRecording()
            } else {
              await this._recordingController.stopRecording()
              await this._recordingController.reset()
            }
          }

          await this._mediaCoordinator.flush()
        } finally {
          if (this._recordingController.ownsResources) {
            await this._recordingController.reset()
          }
          this._recordingCoordinator.resetWorkerState()
          this._log(
            'trace',
            `[WdioPuppeteerVideoService] Recording teardown completed from ${source}.`,
          )
        }
      })
    } finally {
      try {
        await this._ffmpegRuntime.terminateAll()
      } finally {
        await this._ffmpegRuntime.releaseHeldPostProcessSlots()
      }
    }
  }

  async beforeCommand(commandName: string): Promise<void> {
    if (!this._canUseRecordingHooks()) {
      return
    }

    await this._recordingController.beforeWindowCommand(commandName)
  }

  async afterCommand(commandName: string): Promise<void> {
    if (!this._canUseRecordingHooks()) {
      return
    }

    await this._recordingController.afterWindowCommand(commandName)
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
}
