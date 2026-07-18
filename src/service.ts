import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import type { Frameworks, Services } from '@wdio/types'
import type {
  Page,
  Browser as PuppeteerBrowser,
  ScreenRecorder,
} from 'puppeteer-core'
import type { Browser } from 'webdriverio'
import * as artifactIntegrity from './service/artifact-integrity.js'
import * as capture from './service/capture.js'
import {
  type ActiveSegment,
  CI_TRANSCODE_FFMPEG_ARGS,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_RECORDING_START_TIMEOUT_MS,
  type DeferredMergeTask,
  type DeferredPostProcessTask,
  type DeferredTranscodeTask,
  type MergeExecutionOptions,
  type OutputFormat,
  type PersistedSpecRetryState,
  RECORDER_STOP_TIMEOUT_MS,
  type ResolvedRetryContext,
  type ResolvedTranscodeOptions,
  SEGMENT_SWITCH_DELAY_MS,
  WINDOW_SEGMENT_COMMANDS,
  WRITE_STREAM_TIMEOUT_MS,
} from './service/constants.js'
import * as ffmpeg from './service/ffmpeg.js'
import * as ffmpegRunner from './service/ffmpeg-runner.js'
import * as filtering from './service/filtering.js'
import * as logging from './service/logging.js'
import {
  aggregateManifestRun,
  assignManifestRunContext,
  createManifestRunContext,
  type ManifestCaptureDimensions,
  type ManifestRunContext,
  ManifestWorkerRecorder,
  normalizeManifestFramework,
  readManifestRunContext,
} from './service/manifest-runtime.js'
import * as normalization from './service/normalization.js'
import { resolveServiceConfiguration } from './service/options.js'
import * as pageLookup from './service/page-lookup.js'
import * as artifactPaths from './service/paths.js'
import * as postProcess from './service/post-process.js'
import {
  classifySessionProtocol,
  connectPuppeteerWithTimeout,
  describePuppeteerConnectionFailure,
  isChromiumSession,
  type SessionProtocol,
} from './service/protocol.js'
import { RecordingLifecycle } from './service/recording-lifecycle.js'
import {
  PostProcessSlotScheduler,
  RecordingSlotScheduler,
} from './service/recording-slots.js'
import * as retryStateHelpers from './service/retry-state.js'
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
  sanitizeFileToken,
} from './video-name-utils.js'

const replaceFileExtension = (
  filePath: string,
  format: OutputFormat,
): string => {
  const parsed = path.parse(filePath)
  return path.join(parsed.dir, `${parsed.name}.${format}`)
}

/**
 * WebdriverIO Service to record videos using Puppeteer and FFmpeg
 */
export default class WdioPuppeteerVideoService
  implements Services.ServiceInstance
{
  private _browser: Browser | undefined
  private readonly _options: ResolvedWdioPuppeteerVideoServiceOptions
  private _recorder: ScreenRecorder | undefined
  private _activeSegment: ActiveSegment | undefined
  private _currentSegment = 0
  private _currentTestSlug = ''
  private _currentRecordingRetryCount = 0
  private readonly _recordedSegments = new Set<string>()
  private readonly _entityAttemptCount = new Map<string, number>()
  private _specFileRetryAttempt = 0
  private readonly _launcherSpecRetryAttemptCount = new Map<string, number>()
  private _isChromium = false
  private _puppeteerBrowser: PuppeteerBrowser | undefined
  private _sessionProtocol: SessionProtocol = 'unsupported'
  private _recordingDisabledReason: string | undefined
  private _retryStatePersistenceUnavailable = false
  private _specHadFailure = false
  private _specPaths: string[] = []
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
  private readonly _ffmpegProcessRegistry =
    new ffmpegRunner.FfmpegProcessRegistry()
  private readonly _wildcardPatternRegexCache = new Map<string, RegExp>()
  private _pageMarkerCounter = 0
  private _manifestRunContext: ManifestRunContext | undefined
  private _manifestRecorder: ManifestWorkerRecorder | undefined
  private _manifestCaptureDimensions: ManifestCaptureDimensions | undefined

  constructor(options: WdioPuppeteerVideoServiceOptions = {}) {
    const resolvedConfiguration = resolveServiceConfiguration(options)
    this._hasExplicitLogLevel = resolvedConfiguration.hasExplicitLogLevel
    this._logLevel = resolvedConfiguration.logLevel
    this._maxSlugLength = resolvedConfiguration.maxSlugLength
    this._options = resolvedConfiguration.options
    this._recordingSlotScheduler = new RecordingSlotScheduler(
      this._options,
      (level, message, details) => {
        this._log(level, message, details)
      },
    )
    this._postProcessSlotScheduler = new PostProcessSlotScheduler(
      this._options,
      (level, message, details) => {
        this._log(level, message, details)
      },
    )
  }

  async onPrepare(): Promise<void> {
    this._manifestRunContext = await createManifestRunContext(
      this._options.outputDir,
    ).catch((error) => {
      this._log(
        'warn',
        `[WdioPuppeteerVideoService] Failed to initialize manifest journaling: ${normalization.describeError(error)}.`,
      )
      return undefined
    })

    if (!this._options.recordOnRetries) {
      return
    }

    this._retryStatePersistenceUnavailable = false
    this._launcherSpecRetryAttemptCount.clear()
    this._specFileRetryAttempt = 0

    const retryStateDir = retryStateHelpers.getSpecRetryStateDirPath(
      this._options.outputDir,
    )
    await fs
      .rm(retryStateDir, { recursive: true, force: true })
      .catch((error) => {
        this._log(
          'trace',
          `[WdioPuppeteerVideoService] Failed to clean retry-state dir during onPrepare (${retryStateDir}): ${normalization.describeError(error)}`,
        )
      })
    const retryStateDirReady = await fs
      .mkdir(retryStateDir, { recursive: true })
      .then(() => true)
      .catch((error) => {
        this._retryStatePersistenceUnavailable = true
        this._log(
          'warn',
          `[WdioPuppeteerVideoService] Failed to initialize retry-state tracking at ${retryStateDir}: ${normalization.describeError(error)}. Falling back to framework and inferred retry detection only.`,
        )
        return false
      })
    if (!retryStateDirReady) {
      return
    }
    this._log(
      'debug',
      `[WdioPuppeteerVideoService] Initialized retry-state tracking at ${retryStateDir}`,
    )
  }

  async onWorkerStart(
    cid: string,
    capabilities: WebdriverIO.Capabilities,
    specs: string[],
    args?: object,
  ): Promise<void> {
    if (this._manifestRunContext && args) {
      assignManifestRunContext(args, this._manifestRunContext)
    }

    if (!this._options.recordOnRetries) {
      return
    }
    if (this._retryStatePersistenceUnavailable) {
      return
    }

    const specRetryKey = retryStateHelpers.buildSpecRetryKey(
      specs,
      capabilities,
    )
    const specFileRetryAttempt =
      this._launcherSpecRetryAttemptCount.get(specRetryKey) ?? 0
    this._launcherSpecRetryAttemptCount.set(
      specRetryKey,
      specFileRetryAttempt + 1,
    )

    const retryState: PersistedSpecRetryState = {
      specRetryKey,
      specFileRetryAttempt,
    }
    await this._writeSpecRetryState(cid, retryState)
    this._log(
      'debug',
      `[WdioPuppeteerVideoService] Worker start retry context cid=${cid} specFileRetryAttempt=${specFileRetryAttempt} specs=${specs.length}`,
    )
  }

  async onWorkerEnd(
    cid: string,
    exitCode: number,
    specs: string[],
    retries: number,
  ): Promise<void> {
    if (!this._options.recordOnRetries) {
      return
    }

    await this._deleteSpecRetryState(cid)
    this._log(
      'trace',
      `[WdioPuppeteerVideoService] Worker end cleanup cid=${cid} exitCode=${exitCode} retries=${retries} specs=${specs.length}`,
    )
  }

  async onComplete(exitCode = 0): Promise<void> {
    if (this._options.recordOnRetries) {
      this._launcherSpecRetryAttemptCount.clear()
      this._specFileRetryAttempt = 0

      const retryStateDir = retryStateHelpers.getSpecRetryStateDirPath(
        this._options.outputDir,
      )
      await fs
        .rm(retryStateDir, { recursive: true, force: true })
        .catch((error) => {
          this._log(
            'trace',
            `[WdioPuppeteerVideoService] Failed to clean retry-state dir during onComplete (${retryStateDir}): ${normalization.describeError(error)}`,
          )
        })
      this._retryStatePersistenceUnavailable = false
      this._log(
        'debug',
        `[WdioPuppeteerVideoService] Cleared retry-state tracking from ${retryStateDir}`,
      )
    }

    if (this._manifestRunContext) {
      await aggregateManifestRun(this._manifestRunContext, exitCode)
      this._manifestRunContext = undefined
    }
  }

  async beforeSession(
    config: unknown,
    capabilities: WebdriverIO.Capabilities,
    specs: string[],
    cid: string,
  ): Promise<void> {
    const manifestContext = readManifestRunContext(config)
    this._manifestRecorder = manifestContext
      ? new ManifestWorkerRecorder({
          context: manifestContext,
          cid,
          framework: normalizeManifestFramework(
            (config as { framework?: unknown } | undefined)?.framework,
          ),
        })
      : undefined
    this._specFileRetryAttempt = 0
    if (!this._options.recordOnRetries) {
      return
    }

    const retryState = await this._readSpecRetryState(cid)
    if (!retryState) {
      this._log(
        'trace',
        `[WdioPuppeteerVideoService] No persisted retry state found for cid=${cid}; defaulting spec-file retry attempt to 0.`,
      )
      return
    }

    const expectedRetryKey = retryStateHelpers.buildSpecRetryKey(
      specs,
      capabilities,
    )
    if (retryState.specRetryKey !== expectedRetryKey) {
      this._log(
        'trace',
        `[WdioPuppeteerVideoService] Ignoring retry state for cid=${cid} due to spec key mismatch.`,
      )
      return
    }

    this._specFileRetryAttempt = retryState.specFileRetryAttempt
    this._log(
      'debug',
      `[WdioPuppeteerVideoService] Hydrated spec-file retry attempt for cid=${cid}: ${this._specFileRetryAttempt}`,
    )
  }

  async before(
    _capabilities: WebdriverIO.Capabilities,
    specs: string[],
    browser: Browser,
  ): Promise<void> {
    this._browser = browser
    this._specPaths = specs
    this._specHadFailure = false
    this._recordingDisabledReason = undefined
    this._entityAttemptCount.clear()

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

    await fs
      .mkdir(this._options.outputDir ?? DEFAULT_OUTPUT_DIR, { recursive: true })
      .catch((error) => {
        this._log(
          'warn',
          `[WdioPuppeteerVideoService] Failed to create output directory (${this._options.outputDir ?? DEFAULT_OUTPUT_DIR}): ${normalization.describeError(error)}`,
        )
        this._disableRecordingForWorker('output directory is unavailable')
      })
  }

  async beforeTest(test: Frameworks.Test, context: unknown): Promise<void> {
    const manifestScope = this._options.specLevelRecording ? 'spec' : 'test'
    const manifestEntryAlreadyActive =
      manifestScope === 'spec' && !!this._manifestRecorder?.currentEntryId
    await this._manifestRecorder?.beginEntity({
      test,
      scope: manifestScope,
      specPaths: this._specPaths,
    })
    if (!this._canUseRecordingHooks()) {
      if (!manifestEntryAlreadyActive) {
        await this._manifestRecorder?.completeCurrent({
          decision: 'skipped',
          result: test.pending ? 'skipped' : 'unknown',
          reason:
            this._recordingDisabledReason ?? 'recording-hooks-unavailable',
          processingOutcome: 'skipped',
        })
      }
      return
    }

    await this._runSerializedRecordingTask(async () => {
      if (!this._shouldRecordForFilters(test, context)) {
        if (!manifestEntryAlreadyActive) {
          await this._manifestRecorder?.completeCurrent({
            decision: 'skipped',
            result: test.pending ? 'skipped' : 'unknown',
            reason: 'filtered',
            processingOutcome: 'skipped',
          })
        }
        return
      }

      const retryContext = this._resolveRetryContextForEntity(test, context)
      const retryCount = retryContext.effectiveRetryCount
      this._manifestRecorder?.setCurrentAttempt(retryCount + 1)
      const shouldRecordForRetry = this._shouldRecordForRetryCount(retryCount)
      this._logRetryDecision(
        retryContext,
        test.title || test.fullTitle || 'test',
        shouldRecordForRetry,
      )
      if (!shouldRecordForRetry) {
        this._logRetrySkip(retryContext, test.title || test.fullTitle || 'test')
        if (!manifestEntryAlreadyActive) {
          await this._manifestRecorder?.completeCurrent({
            decision: 'skipped',
            result: test.pending ? 'skipped' : 'unknown',
            reason: 'not-a-retry-attempt',
            processingOutcome: 'skipped',
          })
        }
        return
      }

      if (this._options.specLevelRecording) {
        if (this._currentTestSlug) {
          return
        }

        await this._startSpecLevelRecording(retryCount)
        return
      }

      await this._startRecordingForEntity(test, context, retryCount)
    })
  }

  async afterTest(
    test: Frameworks.Test,
    _context: unknown,
    result: Frameworks.TestResult,
  ): Promise<void> {
    await this._manifestRecorder?.recordResult(
      test.pending ? 'skipped' : result.passed ? 'passed' : 'failed',
    )
    await this._afterTestOrScenario(result.passed)
  }

  async beforeScenario(
    world: Frameworks.World,
    context: unknown,
  ): Promise<void> {
    const cucumberEntity = {
      title: world?.pickle?.name || 'scenario',
      fullTitle: world?.pickle?.name || 'scenario',
    } as Frameworks.Test
    const manifestEntryAlreadyActive =
      this._options.specLevelRecording &&
      !!this._manifestRecorder?.currentEntryId
    await this._manifestRecorder?.beginEntity({
      test: cucumberEntity,
      scope: this._options.specLevelRecording ? 'spec' : 'test',
      specPaths: this._specPaths,
    })
    if (!this._canUseRecordingHooks()) {
      if (!manifestEntryAlreadyActive) {
        await this._manifestRecorder?.completeCurrent({
          decision: 'skipped',
          result: 'unknown',
          reason:
            this._recordingDisabledReason ?? 'recording-hooks-unavailable',
          processingOutcome: 'skipped',
        })
      }
      return
    }

    await this._runSerializedRecordingTask(async () => {
      const scenarioContext = context ?? world
      if (!this._shouldRecordForFilters(cucumberEntity, scenarioContext)) {
        if (!manifestEntryAlreadyActive) {
          await this._manifestRecorder?.completeCurrent({
            decision: 'skipped',
            result: 'unknown',
            reason: 'filtered',
            processingOutcome: 'skipped',
          })
        }
        return
      }

      const retryContext = this._resolveRetryContextForEntity(
        cucumberEntity,
        scenarioContext,
      )
      const retryCount = retryContext.effectiveRetryCount
      this._manifestRecorder?.setCurrentAttempt(retryCount + 1)
      const shouldRecordForRetry = this._shouldRecordForRetryCount(retryCount)
      this._logRetryDecision(
        retryContext,
        cucumberEntity.title,
        shouldRecordForRetry,
      )
      if (!shouldRecordForRetry) {
        this._logRetrySkip(retryContext, cucumberEntity.title)
        if (!manifestEntryAlreadyActive) {
          await this._manifestRecorder?.completeCurrent({
            decision: 'skipped',
            result: 'unknown',
            reason: 'not-a-retry-attempt',
            processingOutcome: 'skipped',
          })
        }
        return
      }

      if (this._options.specLevelRecording) {
        if (this._currentTestSlug) {
          return
        }

        await this._startSpecLevelRecording(retryCount)
        return
      }

      await this._startRecordingForEntity(
        cucumberEntity,
        scenarioContext,
        retryCount,
      )
    })
  }

  async afterScenario(
    _world: Frameworks.World,
    result: Frameworks.PickleResult,
  ): Promise<void> {
    await this._manifestRecorder?.recordResult(
      result.passed ? 'passed' : 'failed',
    )
    await this._afterTestOrScenario(result.passed)
  }

  private async _afterTestOrScenario(passed: boolean): Promise<void> {
    if (this._options.specLevelRecording) {
      if (!passed) {
        this._specHadFailure = true
      }
      return
    }

    await this._finalizeIfRecording(passed)
  }

  async after(): Promise<void> {
    await this._teardownRecording('after')
  }

  async afterSession(): Promise<void> {
    await this._teardownRecording('afterSession')
    await this._manifestRecorder?.flush()
    this._browser = undefined
    this._isChromium = false
    this._puppeteerBrowser = undefined
    this._sessionProtocol = 'unsupported'
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
          if (this._options.specLevelRecording && this._currentTestSlug) {
            await this._finalizeCurrentTestRecording(!this._specHadFailure)
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
        this._entityAttemptCount.clear()
        this._specHadFailure = false
        this._log(
          'trace',
          `[WdioPuppeteerVideoService] Recording teardown completed from ${source}.`,
        )
      }
    })
    this._teardownTask = task
    await task
    if (this._teardownTask === task) {
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

    if (!this._options.segmentOnWindowSwitch) {
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

    if (!this._options.segmentOnWindowSwitch) {
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
        await delay(SEGMENT_SWITCH_DELAY_MS)
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
        this._options,
      )
      const recordingOutput = await this._reserveRecordingOutput(
        this._createRecordingOutput(),
      )
      pendingRecordingPath = recordingOutput.recordingPath

      const ffmpegPath = this._resolveFfmpegPath()
      const recorder = await capture.startScreencast(page, {
        capture: this._options,
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

      const writeStream = createWriteStream(recordingOutput.recordingPath, {
        flags: 'r+',
      })
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
        await fs.unlink(pendingRecordingPath).catch(() => {
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
    await fs.unlink(segment.recordingPath).catch(() => {
      /* best-effort partial recording cleanup */
    })
  }

  private async _stopRecorder(recorder: ScreenRecorder): Promise<void> {
    let timeout: NodeJS.Timeout | undefined
    const timeoutTask = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
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
        clearTimeout(timeout)
      }
    }
  }

  private async _acquireRecordingSlotForStart(): Promise<boolean> {
    const acquiredSlot = await this._recordingSlotScheduler.acquire()
    if (acquiredSlot) {
      return true
    }

    const recordingStartMode = this._options.recordingStartMode ?? 'blocking'
    const timeoutSuffix =
      recordingStartMode === 'fastFail'
        ? ` within ${(this._options.recordingStartTimeoutMs ?? DEFAULT_RECORDING_START_TIMEOUT_MS).toString()}ms`
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
      .findActivePage(puppeteerBrowser, targetId)
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
      const puppeteerBrowser = await connectPuppeteerWithTimeout(
        browser,
        this._options.puppeteerConnectionTimeoutMs,
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
    const outputFormat: OutputFormat = this._options.outputFormat ?? 'webm'
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

  private async _startRecordingForEntity(
    test: Frameworks.Test,
    context: unknown,
    retryCount: number,
  ): Promise<void> {
    if (this._currentTestSlug) {
      return
    }

    const metadata = this._applyRetryCountToMetadata(
      collectSlugMetadata(test, context, this._options.fileNameStyle),
      retryCount,
    )
    await this._startRecordingForMetadata(metadata, retryCount)
  }

  private async _startSpecLevelRecording(retryCount: number): Promise<void> {
    const specMetadata = this._buildSpecLevelSlugMetadata(retryCount)
    await this._startRecordingForMetadata(specMetadata, retryCount)
  }

  private _buildSpecLevelSlugMetadata(retryCount: number): SlugMetadata {
    const firstSpecPath = this._specPaths[0] || 'spec'
    const parsedSpecName = path.parse(firstSpecPath).name
    const specToken = sanitizeFileToken(parsedSpecName, 120) || 'spec'
    const specNameToken = specToken.endsWith('_spec')
      ? specToken
      : `${specToken}_spec`
    const allSpecsToken =
      this._specPaths.length > 0 ? this._specPaths.join('|') : firstSpecPath

    return {
      fileToken: specToken,
      testNameToken: specNameToken,
      retryToken: retryCount > 0 ? `_retry${retryCount}` : '',
      hashInput: `spec|${allSpecsToken}|${retryCount}`,
    }
  }

  private async _startRecordingForMetadata(
    metadata: SlugMetadata,
    retryCount: number,
  ): Promise<void> {
    if (this._currentTestSlug) {
      return
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
    this._currentRecordingRetryCount = retryCount
    this._recordedSegments.clear()
    this._currentWindowHandle = undefined
    this._activeSegment = undefined

    const started = await this._startRecording()
    if (!started) {
      await this._manifestRecorder?.completeCurrent({
        decision: 'failed',
        result: 'unknown',
        reason: this._recordingDisabledReason ?? 'recording-start-failed',
        processingOutcome: 'failed',
        processingOperation: 'capture',
      })
      await this._resetTestState()
    }
  }

  private _resolveRetryContextForEntity(
    test: Frameworks.Test,
    context: unknown,
  ): ResolvedRetryContext {
    const explicitFrameworkRetry = this._extractExplicitRetryCount(
      test,
      context,
    )
    let inferredEntityRetry: number | undefined

    if (this._options.recordOnRetries) {
      const metadata = collectSlugMetadata(
        test,
        context,
        this._options.fileNameStyle,
      )
      const retryTrackingKey = `${metadata.fileToken}|${metadata.testNameToken}|${metadata.hashInput}`
      inferredEntityRetry = this._entityAttemptCount.get(retryTrackingKey) ?? 0
      this._entityAttemptCount.set(retryTrackingKey, inferredEntityRetry + 1)
    }

    const effectiveRetryCount = Math.max(
      explicitFrameworkRetry ?? 0,
      this._specFileRetryAttempt,
      inferredEntityRetry ?? 0,
    )

    return {
      explicitFrameworkRetry,
      specFileRetryAttempt: this._specFileRetryAttempt,
      inferredEntityRetry,
      effectiveRetryCount,
    }
  }

  private _extractExplicitRetryCount(
    test: Frameworks.Test,
    context: unknown,
  ): number | undefined {
    const testRetryCount = this._extractRetryValue(
      (test as Frameworks.Test & { _currentRetry?: unknown })._currentRetry,
    )
    if (testRetryCount !== undefined) {
      return testRetryCount
    }

    const contextRecord =
      context && typeof context === 'object'
        ? (context as Record<string, unknown>)
        : undefined
    const contextRetryCount = this._extractRetryValue(
      contextRecord?._currentRetry,
    )
    if (contextRetryCount !== undefined) {
      return contextRetryCount
    }

    const currentTestRecord =
      contextRecord &&
      typeof contextRecord.currentTest === 'object' &&
      contextRecord.currentTest
        ? (contextRecord.currentTest as Record<string, unknown>)
        : undefined
    return this._extractRetryValue(currentTestRecord?._currentRetry)
  }

  private _extractRetryValue(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return undefined
    }

    return Math.floor(value)
  }

  private _applyRetryCountToMetadata(
    metadata: SlugMetadata,
    retryCount: number,
  ): SlugMetadata {
    if (retryCount <= 0) {
      return {
        ...metadata,
        retryToken: '',
      }
    }

    const retryToken = `_retry${retryCount}`
    return {
      ...metadata,
      retryToken,
      hashInput: `${metadata.hashInput}|retry=${retryCount}`,
    }
  }

  private _shouldRecordForRetryCount(retryCount: number): boolean {
    if (!this._options.recordOnRetries) {
      return true
    }

    return retryCount > 0
  }

  private _logRetryDecision(
    retryContext: ResolvedRetryContext,
    entityLabel: string,
    shouldRecord: boolean,
  ): void {
    if (
      !this._options.recordOnRetries ||
      !logging.shouldLog('trace', this._logLevel)
    ) {
      return
    }

    this._log(
      'trace',
      `[WdioPuppeteerVideoService] Retry decision for "${entityLabel}": ${shouldRecord ? 'record' : 'skip'} (effectiveRetry=${retryContext.effectiveRetryCount}, frameworkRetry=${retryContext.explicitFrameworkRetry ?? 0}, specFileRetry=${retryContext.specFileRetryAttempt}, inferredRetry=${retryContext.inferredEntityRetry ?? 0}).`,
    )
  }

  private _logRetrySkip(
    retryContext: ResolvedRetryContext,
    entityLabel: string,
  ): void {
    if (
      !this._options.recordOnRetries ||
      !logging.shouldLog('debug', this._logLevel)
    ) {
      return
    }

    this._log(
      'debug',
      `[WdioPuppeteerVideoService] Skipping recording for "${entityLabel}" because retryCount=0 (frameworkRetry=${retryContext.explicitFrameworkRetry ?? 0}, specFileRetry=${retryContext.specFileRetryAttempt}, inferredRetry=${retryContext.inferredEntityRetry ?? 0}).`,
    )
  }

  private _shouldRecordForFilters(
    test: Frameworks.Test,
    context: unknown,
  ): boolean {
    return filtering.shouldRecordForFilters(
      this._options,
      test,
      context,
      this._wildcardPatternRegexCache,
    )
  }

  private async _finalizeIfRecording(passed: boolean): Promise<void> {
    if (!this._isRecordingActive()) {
      return
    }

    await this._runSerializedRecordingTask(async () => {
      await this._finalizeCurrentTestRecording(passed)
    })
  }

  private async _finalizeCurrentTestRecording(passed: boolean): Promise<void> {
    if (!this._currentTestSlug) {
      return
    }

    let keepArtifacts = false
    const deferredTaskCount = this._deferredPostProcessTasks.length
    try {
      await this._recordingLifecycle.finalize({
        stopRecording: async () => {
          await this._stopRecording()
        },
        processArtifacts: async () => {
          const shouldKeepArtifacts = this._shouldKeepRecording(passed)
          keepArtifacts = shouldKeepArtifacts
          this._log(
            'debug',
            `[WdioPuppeteerVideoService] Finished test recording (passed=${passed}, keepArtifacts=${shouldKeepArtifacts}).`,
          )
          if (!shouldKeepArtifacts) {
            await this._deleteSegments()
            return
          }

          if (this._options.mergeSegments?.enabled) {
            if (this._shouldDeferPostProcessing()) {
              await this._queueDeferredMergeForCurrentTest()
            } else {
              await this._mergeSegmentsForCurrentTest()
            }
          }
        },
      })
      const paths = [...this._recordedSegments]
      const deferred = this._deferredPostProcessTasks.length > deferredTaskCount
      const processingConfigured =
        this._options.mergeSegments?.enabled || this._options.transcode?.enabled
      await this._manifestRecorder?.completeCurrent({
        decision: keepArtifacts
          ? paths.length > 0
            ? 'recorded'
            : 'failed'
          : 'discarded',
        result: passed ? 'passed' : 'failed',
        paths,
        ...(!keepArtifacts ? { reason: 'retention-policy' } : {}),
        processingOutcome: deferred
          ? 'pending'
          : keepArtifacts && processingConfigured
            ? 'completed'
            : keepArtifacts
              ? 'not-required'
              : 'skipped',
        ...(this._options.mergeSegments?.enabled
          ? { processingOperation: 'merge' as const }
          : this._options.transcode?.enabled
            ? { processingOperation: 'transcode' as const }
            : {}),
      })
    } catch (error) {
      await this._manifestRecorder?.completeCurrent({
        decision: 'failed',
        result: passed ? 'passed' : 'failed',
        paths: [...this._recordedSegments],
        reason: normalization.describeError(error),
        processingOutcome: 'failed',
      })
      throw error
    } finally {
      await this._resetTestState()
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
        fs.unlink(file).catch(() => {
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

    const deleteSegments = this._options.mergeSegments?.deleteSegments ?? true
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
      outputFormat: this._options.outputFormat ?? 'webm',
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

    const deleteSegments = this._options.mergeSegments?.deleteSegments ?? true
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
        outputDir: this._options.outputDir || DEFAULT_OUTPUT_DIR,
        runFfmpeg: (args, operation) => this._runFfmpeg(args, operation),
        warn: (message) => {
          this._log('warn', message)
        },
      }),
    )
  }

  private _createResolvedTranscodeOptions(): ResolvedTranscodeOptions {
    const configuredFfmpegArgs = this._options.transcode?.ffmpegArgs
    const ffmpegArgs =
      configuredFfmpegArgs ??
      (this._options.performanceProfile === 'ci'
        ? [...CI_TRANSCODE_FFMPEG_ARGS]
        : undefined)

    return {
      deleteOriginal: this._options.transcode?.deleteOriginal ?? true,
      ...(ffmpegArgs === undefined ? {} : { ffmpegArgs }),
    }
  }

  private _resolveFfmpegPath(): string {
    const configuredPath = this._options.ffmpegPath?.trim()
    const envPath = process.env.FFMPEG_PATH?.trim()
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
      this._options.ffmpegPath?.trim(),
      process.env.FFMPEG_PATH?.trim(),
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

    if (this._options.transcode?.enabled === true) {
      return true
    }

    const mode = this._options.mp4Mode ?? 'auto'
    return mode === 'transcode' || (mode === 'auto' && this._forceMp4Transcode)
  }

  private async _configureMp4RecordingMode(): Promise<void> {
    this._forceMp4Transcode = false

    const outputFormat = this._options.outputFormat ?? 'webm'
    if (outputFormat !== 'mp4') {
      return
    }

    if (this._options.transcode?.enabled === true) {
      return
    }

    const mode = this._options.mp4Mode ?? 'auto'
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
    await capture.primeScreencastFrames(page)
  }

  private async _kickOffScreencastFramesIfEnabled(page: Page): Promise<void> {
    if (!this._options.framePriming) {
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
    await delay(WRITE_STREAM_TIMEOUT_MS)
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
    const recordedSize = await fs
      .stat(segment.recordingPath)
      .then((stats) => stats.size)
      .catch(() => 0)

    if (recordedSize === 0) {
      this._log(
        'warn',
        `[WdioPuppeteerVideoService] Recording file is empty: ${segment.recordingPath}`,
      )
      await fs.unlink(segment.recordingPath).catch(() => {
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

      if (this._options.mergeSegments?.enabled) {
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
        await fs.unlink(segment.recordingPath).catch(() => {
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
    return ffmpegRunner.runFfmpeg(
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
        timeoutMs: this._options.ffmpegTimeoutMs ?? 0,
        warnMissing: (reason) => {
          this._warnMissingFfmpeg(reason)
        },
      },
      {
        processRegistry: this._ffmpegProcessRegistry,
      },
    )
  }

  private async _withPostProcessSlot<T>(
    operation: string,
    task: () => Promise<T>,
  ): Promise<T | undefined> {
    const acquired = await this._postProcessSlotScheduler.acquire()
    if (!acquired) {
      const timeout =
        this._options.postProcessStartTimeoutMs ??
        DEFAULT_RECORDING_START_TIMEOUT_MS
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
    const configuredPath = this._options.ffmpegPath
      ? `Configured ffmpegPath: ${this._options.ffmpegPath}.`
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
    return (this._options.postProcessMode ?? 'immediate') === 'deferred'
  }

  private async _flushDeferredPostProcessTasks(): Promise<void> {
    if (!this._hasDeferredPostProcessTasks()) {
      return
    }

    this._log(
      'info',
      `[WdioPuppeteerVideoService] Processing ${this._deferredPostProcessTasks.length} deferred post-processing task(s).`,
    )

    while (this._deferredPostProcessTasks.length > 0) {
      const nextTask = this._deferredPostProcessTasks.shift()
      if (!nextTask) {
        break
      }

      if (nextTask.kind === 'merge') {
        await this._executeDeferredMergeTask(nextTask)
        continue
      }

      await this._executeDeferredTranscodeTask(nextTask)
    }
  }

  private async _executeDeferredTranscodeTask(
    task: DeferredTranscodeTask,
  ): Promise<void> {
    const inputExists = await fs
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
      await fs.unlink(task.inputPath).catch(() => {
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

  private async _writeSpecRetryState(
    cid: string,
    retryState: PersistedSpecRetryState,
  ): Promise<void> {
    if (this._retryStatePersistenceUnavailable) {
      return
    }

    const retryStateDir = retryStateHelpers.getSpecRetryStateDirPath(
      this._options.outputDir,
    )
    try {
      await fs.mkdir(retryStateDir, { recursive: true })
      const retryStatePath = retryStateHelpers.getSpecRetryStatePathForCid(
        this._options.outputDir,
        cid,
      )
      await fs.writeFile(retryStatePath, JSON.stringify(retryState), 'utf8')
      this._log(
        'trace',
        `[WdioPuppeteerVideoService] Persisted retry state for cid=${cid} at ${retryStatePath} (specFileRetryAttempt=${retryState.specFileRetryAttempt})`,
      )
    } catch (error) {
      this._retryStatePersistenceUnavailable = true
      this._log(
        'warn',
        `[WdioPuppeteerVideoService] Failed to persist retry state for cid=${cid}: ${normalization.describeError(error)}. Falling back to framework and inferred retry detection only.`,
      )
    }
  }

  private async _readSpecRetryState(
    cid: string,
  ): Promise<PersistedSpecRetryState | undefined> {
    const retryStatePath = retryStateHelpers.getSpecRetryStatePathForCid(
      this._options.outputDir,
      cid,
    )
    try {
      const rawValue = await fs.readFile(retryStatePath, 'utf8')
      const parsedValue = JSON.parse(
        rawValue,
      ) as Partial<PersistedSpecRetryState>
      if (typeof parsedValue.specRetryKey !== 'string') {
        this._log(
          'warn',
          `[WdioPuppeteerVideoService] Ignoring retry state for cid=${cid} because specRetryKey is missing or invalid.`,
        )
        return undefined
      }

      const parsedRetryAttempt = this._extractRetryValue(
        parsedValue.specFileRetryAttempt,
      )
      if (parsedRetryAttempt === undefined) {
        this._log(
          'warn',
          `[WdioPuppeteerVideoService] Ignoring retry state for cid=${cid} because specFileRetryAttempt is invalid.`,
        )
        return undefined
      }

      return {
        specRetryKey: parsedValue.specRetryKey,
        specFileRetryAttempt: parsedRetryAttempt,
      }
    } catch (error) {
      const retryStateError = error as NodeJS.ErrnoException
      if (retryStateError.code === 'ENOENT') {
        return undefined
      }
      this._log(
        'warn',
        `[WdioPuppeteerVideoService] Failed to read retry state for cid=${cid}: ${normalization.describeError(error)}`,
      )
      return undefined
    }
  }

  private async _deleteSpecRetryState(cid: string): Promise<void> {
    const retryStatePath = retryStateHelpers.getSpecRetryStatePathForCid(
      this._options.outputDir,
      cid,
    )
    await fs.unlink(retryStatePath).catch((error) => {
      const retryStateError = error as NodeJS.ErrnoException
      if (retryStateError.code === 'ENOENT') {
        return
      }
      this._log(
        'trace',
        `[WdioPuppeteerVideoService] Failed to delete retry state for cid=${cid}: ${normalization.describeError(error)}`,
      )
    })
  }

  private _log(level: LogLevel, message: string, details?: unknown): void {
    logging.writeLog(this._logLevel, level, message, details)
  }

  private _shouldKeepRecording(passed: boolean): boolean {
    if (this._options.recordingRetain === 'all') {
      return true
    }
    if (this._options.recordingRetain === 'retries') {
      return this._currentRecordingRetryCount > 0
    }
    return !passed
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
      this._currentRecordingRetryCount = 0
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
      this._options.fileNameStyle,
    )
    return this._buildTestSlugFromMetadata(metadata)
  }

  private _buildTestSlugFromMetadata(metadata: SlugMetadata): string {
    return buildTestSlugFromMetadata(metadata, {
      maxSlugLength: this._maxSlugLength,
      fileNameStyle: this._options.fileNameStyle ?? 'test',
      fileNameOverflowStrategy:
        this._options.fileNameOverflowStrategy ?? 'truncate',
      sessionIdToken: this._sessionIdToken,
      sessionIdFullToken: this._sessionIdFullToken,
    })
  }

  private _nextPageMarkerId(): string {
    this._pageMarkerCounter += 1
    const sessionToken =
      this._sessionIdToken || this._sessionIdFullToken || 'session'
    return `wdio-video-${sessionToken}-${this._pageMarkerCounter.toString(36)}-${randomUUID()}`
  }
}
