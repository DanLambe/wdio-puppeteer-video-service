import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
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
import {
  ACTIVE_PAGE_POLL_MS,
  ACTIVE_PAGE_TIMEOUT_MS,
  type ActiveSegment,
  DEFAULT_MAX_FILENAME_LENGTH,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_RECORDING_START_TIMEOUT_MS,
  type DeferredMergeTask,
  type DeferredPostProcessTask,
  type DeferredTranscodeTask,
  GLOBAL_RECORDING_SLOT_ACTIVE_STALE_MS,
  GLOBAL_RECORDING_SLOT_HEARTBEAT_MS,
  GLOBAL_RECORDING_SLOT_INVALID_STALE_MS,
  GLOBAL_RECORDING_SLOT_POLL_MS,
  GLOBAL_RECORDING_SLOT_TIMEOUT_MS,
  IN_PROCESS_RECORDING_SLOT_POLL_MS,
  type MergeExecutionOptions,
  type OutputFormat,
  type PersistedSpecRetryState,
  type ResolvedRetryContext,
  type ResolvedTranscodeOptions,
  SEGMENT_SWITCH_DELAY_MS,
  WINDOW_SEGMENT_COMMANDS,
  WINDOWS_DEFAULT_MAX_FILENAME_LENGTH,
  WRITE_STREAM_TIMEOUT_MS,
} from './service/constants.js'
import * as ffmpeg from './service/ffmpeg.js'
import * as filtering from './service/filtering.js'
import * as logging from './service/logging.js'
import * as normalization from './service/normalization.js'
import * as artifactPaths from './service/paths.js'
import * as postProcess from './service/post-process.js'
import type { GlobalRecordingSlotMetadata } from './service/retry-state.js'
import * as retryState from './service/retry-state.js'
import type {
  WdioPuppeteerVideoServiceFileNameOverflowStrategy,
  WdioPuppeteerVideoServiceFileNameStyle,
  WdioPuppeteerVideoServiceLogLevel,
  WdioPuppeteerVideoServiceMergeOptions,
  WdioPuppeteerVideoServiceMp4Mode,
  WdioPuppeteerVideoServiceOptions,
  WdioPuppeteerVideoServicePerformanceProfile,
  WdioPuppeteerVideoServicePostProcessMode,
  WdioPuppeteerVideoServiceRecordingStartMode,
  WdioPuppeteerVideoServiceTranscodeOptions,
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

/**
 * WebdriverIO Service to record videos using Puppeteer and FFmpeg
 */
export default class WdioPuppeteerVideoService
  implements Services.ServiceInstance
{
  private static _activeRecordingSlots = 0
  private static readonly _recordingSlotWaiters: Array<() => void> = []

  private _browser?: Browser
  private readonly _options: WdioPuppeteerVideoServiceOptions
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
  private _recordingDisabledReason: string | undefined
  private _retryStatePersistenceUnavailable = false
  private _specHadFailure = false
  private _specPaths: string[] = []
  private _currentWindowHandle: string | undefined
  private _sessionIdToken = ''
  private _sessionIdFullToken = ''
  private _logLevel: WdioPuppeteerVideoServiceLogLevel = 'warn'
  private readonly _hasExplicitLogLevel: boolean
  private _ffmpegAvailable = false
  private _resolvedFfmpegPath: string | undefined
  private _ffmpegCandidates: string[] = []
  private _ffmpegInitializationTask: Promise<boolean> | undefined
  private _ffmpegInitializationCompleted = false
  private _recordingTask: Promise<void> = Promise.resolve()
  private readonly _deferredPostProcessTasks: DeferredPostProcessTask[] = []
  private _warnedAboutMp4Compatibility = false
  private _warnedAboutMp4AutoFallback = false
  private _warnedAboutMissingFfmpeg = false
  private _forceMp4Transcode = false
  private readonly _slugUsageCount = new Map<string, number>()
  private readonly _maxSlugLength: number
  private _ownsRecordingSlot = false
  private _ownsGlobalRecordingSlot = false
  private _globalRecordingSlotPath: string | undefined
  private _globalRecordingSlotFileHandle: FileHandle | undefined
  private _globalRecordingSlotHeartbeatTimer: NodeJS.Timeout | undefined
  private _globalRecordingSlotStartedAt: number | undefined
  private readonly _wildcardPatternRegexCache = new Map<string, RegExp>()
  private _pageMarkerCounter = 0

  constructor(options: WdioPuppeteerVideoServiceOptions = {}) {
    const performanceProfile = this._normalizePerformanceProfile(
      options.performanceProfile,
    )
    const ciPinnedWarnLogLevel =
      performanceProfile === 'ci' && options.logLevel === undefined
    this._hasExplicitLogLevel =
      typeof options.logLevel === 'string' || ciPinnedWarnLogLevel
    this._logLevel = ciPinnedWarnLogLevel
      ? 'warn'
      : this._normalizeLogLevel(options.logLevel)

    const mergedTranscode = this._normalizeTranscodeOptions(options.transcode)
    const mergedMergeSegments = this._normalizeMergeOptions(
      options.mergeSegments,
    )

    let mergedOptions: WdioPuppeteerVideoServiceOptions = {
      outputDir: 'videos',
      saveAllVideos: false,
      videoWidth: 1280,
      videoHeight: 720,
      fps: 30,
      recordOnRetries: false,
      specLevelRecording: false,
      skipViewPortKickoff: false,
      segmentOnWindowSwitch: true,
      maxConcurrentRecordings: 0,
      maxGlobalRecordings: 0,
      recordingStartMode: 'blocking',
      recordingStartTimeoutMs: DEFAULT_RECORDING_START_TIMEOUT_MS,
      ffmpegTimeoutMs: 0,
      postProcessMode: 'immediate',
      includeSpecPatterns: [],
      excludeSpecPatterns: [],
      includeTagPatterns: [],
      excludeTagPatterns: [],
      outputFormat: 'webm',
      mp4Mode: 'auto',
      fileNameStyle: 'test',
      fileNameOverflowStrategy: 'truncate',
      maxFileNameLength:
        process.platform === 'win32'
          ? WINDOWS_DEFAULT_MAX_FILENAME_LENGTH
          : DEFAULT_MAX_FILENAME_LENGTH,
      ...options,
      performanceProfile,
      transcode: mergedTranscode,
      mergeSegments: mergedMergeSegments,
    }

    if (performanceProfile === 'parallel') {
      mergedOptions = {
        ...mergedOptions,
        videoWidth: options.videoWidth ?? 1280,
        videoHeight: options.videoHeight ?? 720,
        fps: options.fps ?? 24,
        outputFormat: this._normalizeOutputFormat(options.outputFormat),
      }

      if (options.mergeSegments?.enabled === undefined) {
        mergedOptions.mergeSegments = {
          ...mergedMergeSegments,
          enabled: false,
        }
      }
    }

    if (performanceProfile === 'ci') {
      mergedOptions = {
        ...mergedOptions,
        videoWidth: options.videoWidth ?? 1280,
        videoHeight: options.videoHeight ?? 720,
        fps: options.fps ?? 24,
        outputFormat: this._normalizeOutputFormat(options.outputFormat),
        skipViewPortKickoff: options.skipViewPortKickoff ?? true,
        segmentOnWindowSwitch: options.segmentOnWindowSwitch ?? false,
        postProcessMode: options.postProcessMode ?? 'deferred',
        recordingStartMode: options.recordingStartMode ?? 'fastFail',
        recordingStartTimeoutMs:
          options.recordingStartTimeoutMs ?? DEFAULT_RECORDING_START_TIMEOUT_MS,
      }

      if (options.mergeSegments?.enabled === undefined) {
        mergedOptions.mergeSegments = {
          ...mergedMergeSegments,
          enabled: false,
        }
      }
    }

    const normalizedGlobalRecordingLockDir = this._normalizeOptionalDir(
      mergedOptions.globalRecordingLockDir,
    )

    this._options = {
      ...mergedOptions,
      outputDir: this._normalizeOutputDir(mergedOptions.outputDir),
      videoWidth: this._normalizePositiveInt(mergedOptions.videoWidth, 1280),
      videoHeight: this._normalizePositiveInt(mergedOptions.videoHeight, 720),
      fps: this._normalizePositiveInt(mergedOptions.fps, 30),
      maxFileNameLength: this._normalizePositiveInt(
        mergedOptions.maxFileNameLength,
        process.platform === 'win32'
          ? WINDOWS_DEFAULT_MAX_FILENAME_LENGTH
          : DEFAULT_MAX_FILENAME_LENGTH,
      ),
      fileNameOverflowStrategy: this._normalizeFileNameOverflowStrategy(
        mergedOptions.fileNameOverflowStrategy,
      ),
      fileNameStyle: this._normalizeFileNameStyle(mergedOptions.fileNameStyle),
      mp4Mode: this._normalizeMp4Mode(mergedOptions.mp4Mode),
      outputFormat: this._normalizeOutputFormat(mergedOptions.outputFormat),
      performanceProfile,
      recordOnRetries: this._normalizeBoolean(mergedOptions.recordOnRetries),
      specLevelRecording: this._normalizeBoolean(
        mergedOptions.specLevelRecording,
      ),
      skipViewPortKickoff: this._normalizeBoolean(
        mergedOptions.skipViewPortKickoff,
      ),
      segmentOnWindowSwitch: this._normalizeBoolean(
        mergedOptions.segmentOnWindowSwitch,
        true,
      ),
      maxConcurrentRecordings: this._normalizeNonNegativeInt(
        mergedOptions.maxConcurrentRecordings,
        0,
      ),
      maxGlobalRecordings: this._normalizeNonNegativeInt(
        mergedOptions.maxGlobalRecordings,
        0,
      ),
      recordingStartMode: this._normalizeRecordingStartMode(
        mergedOptions.recordingStartMode,
      ),
      recordingStartTimeoutMs: this._normalizePositiveInt(
        mergedOptions.recordingStartTimeoutMs,
        DEFAULT_RECORDING_START_TIMEOUT_MS,
      ),
      ffmpegTimeoutMs: this._normalizeNonNegativeInt(
        mergedOptions.ffmpegTimeoutMs,
        0,
      ),
      ...(normalizedGlobalRecordingLockDir
        ? { globalRecordingLockDir: normalizedGlobalRecordingLockDir }
        : {}),
      transcode: this._normalizeTranscodeOptions(mergedOptions.transcode),
      mergeSegments: this._normalizeMergeOptions(mergedOptions.mergeSegments),
      postProcessMode: this._normalizePostProcessMode(
        mergedOptions.postProcessMode,
      ),
      includeSpecPatterns: this._normalizePatternList(
        mergedOptions.includeSpecPatterns,
      ),
      excludeSpecPatterns: this._normalizePatternList(
        mergedOptions.excludeSpecPatterns,
      ),
      includeTagPatterns: this._normalizePatternList(
        mergedOptions.includeTagPatterns,
      ),
      excludeTagPatterns: this._normalizePatternList(
        mergedOptions.excludeTagPatterns,
      ),
    }

    this._maxSlugLength = this._computeMaxSlugLength()
  }

  async onPrepare(): Promise<void> {
    if (!this._options.recordOnRetries) {
      return
    }

    this._retryStatePersistenceUnavailable = false
    this._launcherSpecRetryAttemptCount.clear()
    this._specFileRetryAttempt = 0

    const retryStateDir = this._getSpecRetryStateDirPath()
    await fs
      .rm(retryStateDir, { recursive: true, force: true })
      .catch((error) => {
        this._log(
          'trace',
          `[WdioPuppeteerVideoService] Failed to clean retry-state dir during onPrepare (${retryStateDir}): ${this._describeError(error)}`,
        )
      })
    const retryStateDirReady = await fs
      .mkdir(retryStateDir, { recursive: true })
      .then(() => true)
      .catch((error) => {
        this._retryStatePersistenceUnavailable = true
        this._log(
          'warn',
          `[WdioPuppeteerVideoService] Failed to initialize retry-state tracking at ${retryStateDir}: ${this._describeError(error)}. Falling back to framework and inferred retry detection only.`,
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
  ): Promise<void> {
    if (!this._options.recordOnRetries) {
      return
    }
    if (this._retryStatePersistenceUnavailable) {
      return
    }

    const specRetryKey = this._buildSpecRetryKey(specs, capabilities)
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

  async onComplete(): Promise<void> {
    if (!this._options.recordOnRetries) {
      return
    }

    this._launcherSpecRetryAttemptCount.clear()
    this._specFileRetryAttempt = 0

    const retryStateDir = this._getSpecRetryStateDirPath()
    await fs
      .rm(retryStateDir, { recursive: true, force: true })
      .catch((error) => {
        this._log(
          'trace',
          `[WdioPuppeteerVideoService] Failed to clean retry-state dir during onComplete (${retryStateDir}): ${this._describeError(error)}`,
        )
      })
    this._retryStatePersistenceUnavailable = false
    this._log(
      'debug',
      `[WdioPuppeteerVideoService] Cleared retry-state tracking from ${retryStateDir}`,
    )
  }

  async beforeSession(
    _config: unknown,
    capabilities: WebdriverIO.Capabilities,
    specs: string[],
    cid: string,
  ): Promise<void> {
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

    const expectedRetryKey = this._buildSpecRetryKey(specs, capabilities)
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
      const inheritedLogLevel = this._resolveWdioLogLevel(browser)
      this._logLevel = this._normalizeLogLevel(inheritedLogLevel)
    }

    this._sessionIdToken = this._buildSessionIdToken(browser.sessionId)
    this._sessionIdFullToken = this._buildFullSessionIdToken(browser.sessionId)
    const caps = browser.capabilities
    const browserName = caps.browserName?.toLowerCase()
    this._isChromium =
      browserName === 'chrome' ||
      browserName === 'microsoftedge' ||
      browserName === 'edge' ||
      'goog:chromeOptions' in caps ||
      'ms:edgeOptions' in caps

    if (!this._isChromium) {
      this._log(
        'warn',
        '[WdioPuppeteerVideoService] Video recording is only supported on Chromium-based browsers.',
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
          `[WdioPuppeteerVideoService] Failed to create output directory (${this._options.outputDir ?? DEFAULT_OUTPUT_DIR}): ${this._describeError(error)}`,
        )
        this._disableRecordingForWorker('output directory is unavailable')
      })
  }

  async beforeTest(test: Frameworks.Test, context: unknown): Promise<void> {
    if (!this._canUseRecordingHooks()) {
      return
    }

    await this._runSerializedRecordingTask(async () => {
      if (!this._shouldRecordForFilters(test, context)) {
        return
      }

      const retryContext = this._resolveRetryContextForEntity(test, context)
      const retryCount = retryContext.effectiveRetryCount
      const shouldRecordForRetry = this._shouldRecordForRetryCount(retryCount)
      this._logRetryDecision(
        retryContext,
        test.title || test.fullTitle || 'test',
        shouldRecordForRetry,
      )
      if (!shouldRecordForRetry) {
        this._logRetrySkip(retryContext, test.title || test.fullTitle || 'test')
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
    _test: Frameworks.Test,
    _context: unknown,
    result: Frameworks.TestResult,
  ): Promise<void> {
    await this._afterTestOrScenario(result.passed)
  }

  async beforeScenario(
    world: Frameworks.World,
    context: unknown,
  ): Promise<void> {
    if (!this._canUseRecordingHooks()) {
      return
    }

    await this._runSerializedRecordingTask(async () => {
      const cucumberEntity = {
        title: world?.pickle?.name || 'scenario',
        fullTitle: world?.pickle?.name || 'scenario',
      } as Frameworks.Test
      const scenarioContext = context ?? world
      if (!this._shouldRecordForFilters(cucumberEntity, scenarioContext)) {
        return
      }

      const retryContext = this._resolveRetryContextForEntity(
        cucumberEntity,
        scenarioContext,
      )
      const retryCount = retryContext.effectiveRetryCount
      const shouldRecordForRetry = this._shouldRecordForRetryCount(retryCount)
      this._logRetryDecision(
        retryContext,
        cucumberEntity.title,
        shouldRecordForRetry,
      )
      if (!shouldRecordForRetry) {
        this._logRetrySkip(retryContext, cucumberEntity.title)
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
    if (!this._isRecordingActive() && !this._hasDeferredPostProcessTasks()) {
      return
    }

    await this._runSerializedRecordingTask(async () => {
      if (this._isRecordingActive()) {
        if (this._options.specLevelRecording && this._currentTestSlug) {
          await this._finalizeCurrentTestRecording(!this._specHadFailure)
        } else {
          await this._stopRecording()
          await this._resetTestState()
        }
      }

      await this._flushDeferredPostProcessTasks()
      this._entityAttemptCount.clear()
      this._specHadFailure = false
    })
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

    const ffmpegReady = await this._ensureFfmpegReady()
    if (!ffmpegReady) {
      return false
    }

    const browser = this._browser
    const acquiredRecordingSlot = await this._acquireRecordingSlotForStart()
    if (!acquiredRecordingSlot) {
      return false
    }

    try {
      const activePage = await this._prepareRecordingPage(browser)
      if (!activePage) {
        return false
      }

      const { page, windowHandle } = activePage
      const recordingOutput = this._createRecordingOutput()

      const ffmpegPath = this._resolveFfmpegPath()
      const recorder = await page.screencast({
        format: recordingOutput.recordingFormat,
        fps: this._options.fps || 30,
        ffmpegPath,
      })

      const writeStream = createWriteStream(recordingOutput.recordingPath)
      const writeStreamDone = finished(writeStream)
      let activeSegmentRef: ActiveSegment | undefined
      const onWriteStreamError = (error: NodeJS.ErrnoException) => {
        if (activeSegmentRef?.writeStreamErrored) {
          return
        }
        const writeErrorMessage = this._describeError(error)
        if (activeSegmentRef) {
          activeSegmentRef.writeStreamErrored = true
          activeSegmentRef.writeStreamErrorMessage = writeErrorMessage
        }
        if (this._isBenignStreamWriteError(error)) {
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
          `[WdioPuppeteerVideoService] Recorder stream error: ${this._describeError(error)}`,
        )
      }
      writeStream.on('error', onWriteStreamError)
      recorder.on('error', onRecorderError)
      recorder.pipe(writeStream)

      const transcodeOptions = this._createResolvedTranscodeOptions()

      this._recorder = recorder
      this._activeSegment = {
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
      activeSegmentRef = this._activeSegment

      this._currentWindowHandle = windowHandle
      this._log(
        'debug',
        `[WdioPuppeteerVideoService] Recording segment ${this._currentSegment} to ${recordingOutput.outputPath}`,
      )

      await this._kickOffScreencastFramesIfEnabled(page)
      return true
    } catch (e) {
      this._log(
        'error',
        '[WdioPuppeteerVideoService] Failed to start recording:',
        e,
      )
      return false
    } finally {
      if (acquiredRecordingSlot && !this._recorder) {
        await this._releaseRecordingSlot()
      }
    }
  }

  private async _acquireRecordingSlotForStart(): Promise<boolean> {
    const acquiredSlot = await this._acquireRecordingSlot()
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
    const puppeteerBrowser =
      (await browser.getPuppeteer()) as unknown as PuppeteerBrowser
    const windowHandle = await browser
      .getWindowHandle()
      .catch(() => undefined /* window may already be closed */)

    const targetId = this._nextPageMarkerId()
    await browser.execute((id: string) => {
      const win = globalThis as unknown as { _wdio_video_id?: string }
      win._wdio_video_id = id
    }, targetId)

    const page = await this._findActivePage(puppeteerBrowser, targetId)
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
      outputPath: this._getSegmentPath(outputFormat),
      recordingFormat,
      recordingPath: this._getSegmentPath(recordingFormat),
      transcodeEnabled,
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
      this._collectSlugMetadata(test, context),
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
    const specToken = this._sanitizeFileToken(parsedSpecName, 120) || 'spec'
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
    this._currentTestSlug = this._reserveUniqueSlug(baseSlug)
    this._currentSegment = 1
    this._currentRecordingRetryCount = retryCount
    this._recordedSegments.clear()
    this._currentWindowHandle = undefined
    this._activeSegment = undefined

    const started = await this._startRecording()
    if (!started) {
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
      const metadata = this._collectSlugMetadata(test, context)
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
    if (!this._options.recordOnRetries || !this._isLogLevelEnabled('trace')) {
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
    if (!this._options.recordOnRetries || !this._isLogLevelEnabled('debug')) {
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

    await this._stopRecording()

    const shouldKeepRetryRecording =
      !!this._options.recordOnRetries && this._currentRecordingRetryCount > 0
    const shouldKeepArtifacts =
      !passed || !!this._options.saveAllVideos || shouldKeepRetryRecording
    this._log(
      'debug',
      `[WdioPuppeteerVideoService] Finished test recording (passed=${passed}, keepArtifacts=${shouldKeepArtifacts}).`,
    )
    if (!shouldKeepArtifacts) {
      await this._deleteSegments()
      await this._resetTestState()
      return
    }

    if (this._options.mergeSegments?.enabled) {
      if (this._shouldDeferPostProcessing()) {
        await this._queueDeferredMergeForCurrentTest()
      } else {
        await this._mergeSegmentsForCurrentTest()
      }
    }

    await this._resetTestState()
  }

  private async _stopRecording(): Promise<void> {
    const recorder = this._recorder
    const activeSegment = this._activeSegment
    this._recorder = undefined
    this._activeSegment = undefined

    if (!recorder || !activeSegment) {
      await this._releaseRecordingSlot()
      return
    }
    try {
      await recorder.stop()
    } catch (e) {
      this._log(
        'warn',
        '[WdioPuppeteerVideoService] Error stopping recorder:',
        e,
      )
    }

    try {
      const streamOk = await this._waitForWriteStream(activeSegment)
      if (!streamOk) {
        this._log(
          'warn',
          `[WdioPuppeteerVideoService] Recording stream did not finish cleanly for: ${activeSegment.recordingPath}`,
        )
        this._markSegmentAsUnclean(activeSegment)
      }

      await this._finalizeSegment(activeSegment)
      this._log(
        'debug',
        `[WdioPuppeteerVideoService] Finalized segment ${this._currentSegment} (${activeSegment.outputPath})`,
      )
    } finally {
      recorder.off('error', activeSegment.onRecorderError)
      activeSegment.writeStream.off('error', activeSegment.onWriteStreamError)
      await this._releaseRecordingSlot()
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

    const segmentPaths = this._collectCurrentTestSegmentPaths()
    if (segmentPaths.length === 0) {
      return
    }

    const deleteSegments = this._options.mergeSegments?.deleteSegments ?? true
    const mergedFormat = this._resolveMergeFormat(
      segmentPaths,
      'deferred merge',
    )
    if (!mergedFormat) {
      return
    }

    const mergeTask = postProcess.createDeferredMergeTask({
      deleteSegments,
      getMergedOutputPath: (format) => this._getMergedOutputPath(format),
      mergedFormat,
      outputFormat: this._options.outputFormat ?? 'webm',
      segmentPaths,
      shouldTranscodeMergedOutput: this._shouldTranscode('mp4'),
      transcodeOptions: this._createResolvedTranscodeOptions(),
    })

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

    const segmentPaths = this._collectCurrentTestSegmentPaths()

    if (segmentPaths.length === 0) {
      return
    }

    const deleteSegments = this._options.mergeSegments?.deleteSegments ?? true
    const mergedFormat = this._resolveMergeFormat(segmentPaths, 'merge')
    if (!mergedFormat) {
      return
    }

    const mergedPath = this._getMergedOutputPath(mergedFormat)
    this._log(
      'debug',
      `[WdioPuppeteerVideoService] Attempting merge for ${segmentPaths.length} segments into ${mergedPath}`,
    )

    const merged = await this._mergeSegmentPathsToOutput({
      segmentPaths,
      mergedPath,
      deleteSegments,
      writeFailureContext: 'merge',
      ffmpegOperation: 'segment merge',
    })
    if (!merged) {
      return
    }

    this._recordedSegments.add(mergedPath)
    if (deleteSegments) {
      for (const segmentPath of segmentPaths) {
        this._recordedSegments.delete(segmentPath)
      }
    }
  }

  private _resolveMergeFormat(
    segmentPaths: string[],
    operationName: string,
  ): OutputFormat | undefined {
    return artifactPaths.resolveMergeFormat(
      segmentPaths,
      operationName,
      (message) => {
        this._log('warn', message)
      },
    )
  }

  private async _mergeSegmentPathsToOutput(
    options: MergeExecutionOptions,
  ): Promise<boolean> {
    return postProcess.mergeSegmentPathsToOutput({
      ...options,
      outputDir: this._options.outputDir || DEFAULT_OUTPUT_DIR,
      runFfmpeg: (args, operation) => this._runFfmpeg(args, operation),
      warn: (message) => {
        this._log('warn', message)
      },
    })
  }

  private _collectCurrentTestSegmentPaths(): string[] {
    return artifactPaths.collectCurrentTestSegmentPaths(
      this._currentTestSlug,
      this._recordedSegments,
    )
  }

  private _getSegmentPath(format?: OutputFormat): string {
    return artifactPaths.getSegmentPath(
      this._options.outputDir,
      this._currentTestSlug,
      this._currentSegment,
      format ?? this._options.outputFormat,
    )
  }

  private _getMergedOutputPath(format?: OutputFormat): string {
    return artifactPaths.getMergedOutputPath(
      this._options.outputDir,
      this._currentTestSlug,
      format ?? this._options.outputFormat,
    )
  }

  private _extractPartNumber(filePath: string): number {
    return artifactPaths.extractPartNumber(filePath)
  }

  private _createResolvedTranscodeOptions(): ResolvedTranscodeOptions {
    return {
      deleteOriginal: this._options.transcode?.deleteOriginal ?? true,
      ...(this._options.transcode?.ffmpegArgs === undefined
        ? {}
        : { ffmpegArgs: this._options.transcode.ffmpegArgs }),
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
    this._ffmpegCandidates = this._getFfmpegCandidates()
    this._resolvedFfmpegPath = await this._resolveAvailableFfmpegPath(
      this._ffmpegCandidates,
    )
    this._ffmpegAvailable = !!this._resolvedFfmpegPath
    if (!this._ffmpegAvailable) {
      this._warnMissingFfmpeg('Video recording is disabled for this worker.')
      return false
    }

    this._log(
      'info',
      `[WdioPuppeteerVideoService] Using ffmpeg binary: ${this._resolvedFfmpegPath}`,
    )
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
    const supportsDirectMp4 = await this._supportsDirectMp4(ffmpegPath)
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

  private async _findActivePage(
    puppeteerBrowser: PuppeteerBrowser,
    targetId: string,
  ): Promise<Page | undefined> {
    const startedAt = Date.now()

    while (Date.now() - startedAt < ACTIVE_PAGE_TIMEOUT_MS) {
      const pages = await puppeteerBrowser
        .pages()
        .catch(() => [] /* browser may be closing */)
      const page = await this._findPageWithId(pages, targetId)
      if (page) {
        return page
      }
      await delay(ACTIVE_PAGE_POLL_MS)
    }

    return undefined
  }

  private async _kickOffScreencastFrames(page: Page): Promise<void> {
    const targetWidth = this._options.videoWidth ?? 1280
    const targetHeight = this._options.videoHeight ?? 720

    await page
      .setViewport({ width: targetWidth + 1, height: targetHeight })
      .catch(() => {
        /* best-effort viewport resize */
      })
    await delay(50)
    await page
      .setViewport({ width: targetWidth, height: targetHeight })
      .catch(() => {
        /* best-effort viewport resize */
      })
  }

  private async _kickOffScreencastFramesIfEnabled(page: Page): Promise<void> {
    if (this._options.skipViewPortKickoff) {
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
      this._deferredPostProcessTasks.push(transcodeTask)
      this._log(
        'debug',
        `[WdioPuppeteerVideoService] Queued deferred transcode: ${segment.recordingPath} -> ${segment.outputPath}`,
      )
      return
    }

    const ok = await this._transcodeToH264Mp4(
      segment.recordingPath,
      segment.outputPath,
      segment,
    )
    if (ok) {
      this._recordedSegments.add(segment.outputPath)
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
  }

  private async _transcodeToH264Mp4(
    inputPath: string,
    outputPath: string,
    segment: ActiveSegment,
  ): Promise<boolean> {
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
  ): Promise<boolean> {
    return this._runFfmpeg(
      postProcess.buildH264TranscodeArgs(inputPath, outputPath, ffmpegArgs),
      'transcode',
    )
  }

  private async _runFfmpeg(
    args: string[],
    operation: string,
  ): Promise<boolean> {
    if (!this._ffmpegAvailable) {
      this._warnMissingFfmpeg(
        `Skipping ffmpeg ${operation} because ffmpeg is unavailable.`,
      )
      return false
    }

    const ffmpegPath = this._resolveFfmpegPath()

    return new Promise<boolean>((resolve) => {
      const proc = this._spawnFfmpegProcess(ffmpegPath, args)
      let stderr = ''
      let settled = false
      let timeout: NodeJS.Timeout | undefined

      const settle = (value: boolean) => {
        if (settled) {
          return
        }

        settled = true
        if (timeout) {
          clearTimeout(timeout)
        }
        resolve(value)
      }

      const timeoutMs = this._options.ffmpegTimeoutMs ?? 0
      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          this._log(
            'warn',
            `[WdioPuppeteerVideoService] ffmpeg ${operation} timed out after ${timeoutMs.toString()}ms`,
          )
          proc.kill()
          settle(false)
        }, timeoutMs)
        timeout.unref?.()
      }

      proc.stderr?.on('data', (chunk) => {
        const next = stderr + chunk.toString('utf8')
        stderr = next.length > 32_768 ? next.slice(-32_768) : next
      })

      proc.on('error', (error) => {
        if (settled) {
          return
        }

        this._ffmpegAvailable = false
        this._warnMissingFfmpeg(
          `ffmpeg ${operation} failed to start: ${error.message}`,
        )
        this._log(
          'warn',
          `[WdioPuppeteerVideoService] Failed to spawn ffmpeg for ${operation}: ${error.message}`,
        )
        settle(false)
      })

      proc.on('close', (code) => {
        if (settled) {
          return
        }

        if (code === 0) {
          settle(true)
          return
        }

        const details = stderr.trim()
        if (details) {
          this._log(
            'warn',
            `[WdioPuppeteerVideoService] ffmpeg ${operation} exited with code ${code}: ${details}`,
          )
        } else {
          this._log(
            'warn',
            `[WdioPuppeteerVideoService] ffmpeg ${operation} exited with code ${code}`,
          )
        }
        settle(false)
      })
    })
  }

  private _spawnFfmpegProcess(
    ffmpegPath: string,
    args: string[],
  ): ReturnType<typeof spawn> {
    return spawn(ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
  }

  private async _resolveAvailableFfmpegPath(
    candidates: string[],
  ): Promise<string | undefined> {
    return ffmpeg.resolveAvailableFfmpegPath(candidates)
  }

  private _getFfmpegCandidates(): string[] {
    return ffmpeg.getFfmpegCandidates(
      this._options.ffmpegPath?.trim(),
      process.env.FFMPEG_PATH?.trim(),
    )
  }

  private async _supportsDirectMp4(ffmpegPath: string): Promise<boolean> {
    return ffmpeg.probeDirectMp4Support(ffmpegPath, {
      onProbeFailure: (details) => {
        this._log(
          'debug',
          `[WdioPuppeteerVideoService] Direct MP4 probe failed: ${details}`,
        )
      },
    })
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

  private async _findPageWithId(
    pages: Page[],
    targetId: string,
  ): Promise<Page | undefined> {
    for (const page of pages) {
      try {
        const id = await page.evaluate(() => {
          const win = globalThis as unknown as { _wdio_video_id?: string }
          return win._wdio_video_id
        })
        if (id === targetId) {
          return page
        }
      } catch {
        // access denied or other error on page
      }
    }
    return undefined
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
      return
    }

    const ok = await this._transcodeToH264Mp4WithArgs(
      task.inputPath,
      task.outputPath,
      task.ffmpegArgs,
    )
    if (!ok) {
      return
    }

    if (task.deleteOriginal && task.inputPath !== task.outputPath) {
      await fs.unlink(task.inputPath).catch(() => {
        /* best-effort cleanup */
      })
    }
  }

  private async _executeDeferredMergeTask(
    task: DeferredMergeTask,
  ): Promise<void> {
    const merged = await this._mergeSegmentPathsToOutput({
      segmentPaths: task.segmentPaths,
      mergedPath: task.mergedPath,
      deleteSegments: task.deleteSegments,
      writeFailureContext: 'deferred merge',
      ffmpegOperation: 'deferred segment merge',
    })
    if (!merged) {
      return
    }

    if (!task.transcodeToMp4) {
      return
    }

    const transcodeTask: DeferredTranscodeTask = {
      kind: 'transcode',
      inputPath: task.mergedPath,
      outputPath: task.transcodeToMp4.outputPath,
      deleteOriginal: task.transcodeToMp4.deleteOriginal,
    }
    if (task.transcodeToMp4.ffmpegArgs !== undefined) {
      transcodeTask.ffmpegArgs = task.transcodeToMp4.ffmpegArgs
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

  private async _acquireRecordingSlot(): Promise<boolean> {
    if (
      this._ownsRecordingSlot &&
      ((this._options.maxGlobalRecordings ?? 0) <= 0 ||
        this._ownsGlobalRecordingSlot)
    ) {
      return true
    }

    const startTimeoutMs = this._getRecordingStartTimeoutMs()
    const inProcessSlotAcquired =
      await this._acquireInProcessRecordingSlot(startTimeoutMs)
    if (!inProcessSlotAcquired) {
      return false
    }

    const globalSlotAcquired =
      await this._acquireGlobalRecordingSlot(startTimeoutMs)
    if (globalSlotAcquired) {
      return true
    }

    this._releaseInProcessRecordingSlot()
    return false
  }

  private async _acquireInProcessRecordingSlot(
    timeoutMs: number | undefined,
  ): Promise<boolean> {
    const maxConcurrentRecordings = this._options.maxConcurrentRecordings ?? 0
    if (maxConcurrentRecordings <= 0 || this._ownsRecordingSlot) {
      return true
    }

    if (timeoutMs !== undefined) {
      const deadline = Date.now() + Math.max(0, timeoutMs)
      while (Date.now() <= deadline) {
        if (
          WdioPuppeteerVideoService._activeRecordingSlots <
          maxConcurrentRecordings
        ) {
          WdioPuppeteerVideoService._activeRecordingSlots += 1
          this._ownsRecordingSlot = true
          this._log(
            'debug',
            `[WdioPuppeteerVideoService] Acquired in-process recording slot (${WdioPuppeteerVideoService._activeRecordingSlots}/${maxConcurrentRecordings}).`,
          )
          return true
        }
        await delay(IN_PROCESS_RECORDING_SLOT_POLL_MS)
      }

      return false
    }

    await new Promise<void>((resolve) => {
      const tryAcquire = () => {
        if (
          WdioPuppeteerVideoService._activeRecordingSlots <
          maxConcurrentRecordings
        ) {
          WdioPuppeteerVideoService._activeRecordingSlots += 1
          this._ownsRecordingSlot = true
          this._log(
            'debug',
            `[WdioPuppeteerVideoService] Acquired in-process recording slot (${WdioPuppeteerVideoService._activeRecordingSlots}/${maxConcurrentRecordings}).`,
          )
          resolve()
          return
        }

        WdioPuppeteerVideoService._recordingSlotWaiters.push(tryAcquire)
      }

      tryAcquire()
    })

    return true
  }

  private async _acquireGlobalRecordingSlot(
    timeoutMs: number | undefined,
  ): Promise<boolean> {
    const maxGlobalRecordings = this._options.maxGlobalRecordings ?? 0
    if (maxGlobalRecordings <= 0 || this._ownsGlobalRecordingSlot) {
      return true
    }

    const lockDir = this._resolveGlobalRecordingLockDir()
    await fs.mkdir(lockDir, { recursive: true }).catch(() => {
      /* best-effort lock-dir creation */
    })

    const timeout = timeoutMs ?? GLOBAL_RECORDING_SLOT_TIMEOUT_MS
    const deadline = Date.now() + Math.max(0, timeout)
    while (Date.now() <= deadline) {
      const acquired = await this._tryAcquireGlobalRecordingSlot(
        lockDir,
        maxGlobalRecordings,
      )
      if (acquired) {
        return true
      }

      if (Date.now() >= deadline) {
        break
      }

      await delay(GLOBAL_RECORDING_SLOT_POLL_MS)
    }

    return false
  }

  private _getRecordingStartTimeoutMs(): number | undefined {
    if ((this._options.recordingStartMode ?? 'blocking') !== 'fastFail') {
      return undefined
    }

    return this._options.recordingStartTimeoutMs
  }

  private async _tryAcquireGlobalRecordingSlot(
    lockDir: string,
    maxGlobalRecordings: number,
  ): Promise<boolean> {
    for (let slotIndex = 1; slotIndex <= maxGlobalRecordings; slotIndex += 1) {
      const slotPath = path.join(lockDir, `slot-${slotIndex}.lock`)
      try {
        const acquired = await this._openOwnedGlobalRecordingSlot(slotPath)
        if (acquired) {
          return true
        }
      } catch (error) {
        const slotError = error as NodeJS.ErrnoException
        if (slotError.code === 'EEXIST') {
          await this._cleanupStaleGlobalRecordingSlot(slotPath)
        }
      }
    }

    return false
  }

  private async _openOwnedGlobalRecordingSlot(
    slotPath: string,
  ): Promise<boolean> {
    const fileHandle = await fs.open(slotPath, 'wx')
    const startedAt = Date.now()
    const metadataWritten = await this._writeGlobalRecordingSlotMetadata(
      fileHandle,
      startedAt,
    )
    if (!metadataWritten) {
      this._log(
        'debug',
        `[WdioPuppeteerVideoService] Discarding global recording slot candidate without metadata: ${slotPath}`,
      )
      await this._discardGlobalRecordingSlotCandidate(slotPath, fileHandle)
      return false
    }

    this._ownsGlobalRecordingSlot = true
    this._globalRecordingSlotPath = slotPath
    this._globalRecordingSlotFileHandle = fileHandle
    this._globalRecordingSlotStartedAt = startedAt
    this._startGlobalRecordingSlotHeartbeat()
    this._log(
      'debug',
      `[WdioPuppeteerVideoService] Acquired global recording slot: ${slotPath}`,
    )
    return true
  }

  private async _writeGlobalRecordingSlotMetadata(
    fileHandle: FileHandle,
    startedAt: number,
  ): Promise<boolean> {
    const metadata = Buffer.from(
      JSON.stringify({
        pid: process.pid,
        startedAt,
        lastUpdatedAt: Date.now(),
      }),
      'utf8',
    )

    try {
      await fileHandle.truncate(0)
      let bytesWritten = 0
      while (bytesWritten < metadata.length) {
        const writeResult = await fileHandle.write(
          metadata,
          bytesWritten,
          metadata.length - bytesWritten,
          bytesWritten,
        )
        if (writeResult.bytesWritten <= 0) {
          return false
        }
        bytesWritten += writeResult.bytesWritten
      }
      return true
    } catch {
      return false
    }
  }

  private async _discardGlobalRecordingSlotCandidate(
    slotPath: string,
    fileHandle: FileHandle,
  ): Promise<void> {
    await fileHandle.close().catch(() => {
      /* best-effort slot close */
    })
    await fs.unlink(slotPath).catch(() => {
      /* best-effort candidate cleanup */
    })
  }

  private async _cleanupStaleGlobalRecordingSlot(
    slotPath: string,
  ): Promise<void> {
    const slotStats = await fs.stat(slotPath).catch(() => undefined)
    if (!slotStats) {
      return
    }

    const fileContents = await fs.readFile(slotPath, 'utf8').catch(() => '')
    const slotMetadata = this._parseGlobalRecordingSlotMetadata(fileContents)
    const parsedPid = slotMetadata?.pid
    if (parsedPid) {
      const lastUpdatedAtMs = this._resolveGlobalRecordingSlotLastUpdatedAtMs(
        slotMetadata,
        slotStats.mtimeMs,
      )
      if (this._isProcessAlive(parsedPid)) {
        if (!this._isGlobalRecordingSlotFresh(lastUpdatedAtMs)) {
          this._log(
            'debug',
            `[WdioPuppeteerVideoService] Removing stale global recording slot with expired heartbeat for pid=${parsedPid}: ${slotPath}`,
          )
          await fs.unlink(slotPath).catch(() => {
            /* best-effort stale-slot cleanup */
          })
          return
        }

        this._log(
          'debug',
          `[WdioPuppeteerVideoService] Keeping active global recording slot owned by pid=${parsedPid}: ${slotPath}`,
        )
        return
      }

      this._log(
        'debug',
        `[WdioPuppeteerVideoService] Removing stale global recording slot for exited pid=${parsedPid}: ${slotPath}`,
      )
      await fs.unlink(slotPath).catch(() => {
        /* best-effort stale-slot cleanup */
      })
      return
    }

    if (!this._shouldCleanupInvalidGlobalRecordingSlot(slotStats.mtimeMs)) {
      this._log(
        'debug',
        `[WdioPuppeteerVideoService] Keeping recent invalid global recording slot during grace window: ${slotPath}`,
      )
      return
    }

    this._log(
      'debug',
      `[WdioPuppeteerVideoService] Removing stale invalid global recording slot: ${slotPath}`,
    )
    await fs.unlink(slotPath).catch(() => {
      /* best-effort stale-slot cleanup */
    })
  }

  private _shouldCleanupInvalidGlobalRecordingSlot(
    lastUpdatedAtMs: number,
  ): boolean {
    return (
      Date.now() - lastUpdatedAtMs >= GLOBAL_RECORDING_SLOT_INVALID_STALE_MS
    )
  }

  private _isGlobalRecordingSlotFresh(lastUpdatedAtMs: number): boolean {
    return Date.now() - lastUpdatedAtMs < GLOBAL_RECORDING_SLOT_ACTIVE_STALE_MS
  }

  private _resolveGlobalRecordingSlotLastUpdatedAtMs(
    slotMetadata: GlobalRecordingSlotMetadata | undefined,
    fallbackLastUpdatedAtMs: number,
  ): number {
    return (
      slotMetadata?.lastUpdatedAt ??
      slotMetadata?.startedAt ??
      fallbackLastUpdatedAtMs
    )
  }

  private _extractPidFromSlotFile(fileContents: string): number | undefined {
    return retryState.extractPidFromSlotFile(fileContents)
  }

  private _parseGlobalRecordingSlotMetadata(
    fileContents: string,
  ): GlobalRecordingSlotMetadata | undefined {
    return retryState.parseGlobalRecordingSlotMetadata(fileContents)
  }

  private _isProcessAlive(pid: number): boolean {
    return retryState.isProcessAlive(pid)
  }

  private _getSpecRetryStateDirPath(): string {
    return retryState.getSpecRetryStateDirPath(this._options.outputDir)
  }

  private _getSpecRetryStatePathForCid(cid: string): string {
    return retryState.getSpecRetryStatePathForCid(this._options.outputDir, cid)
  }

  private _buildSpecRetryKey(
    specs: string[],
    capabilities: WebdriverIO.Capabilities,
  ): string {
    return retryState.buildSpecRetryKey(specs, capabilities)
  }

  private async _writeSpecRetryState(
    cid: string,
    retryState: PersistedSpecRetryState,
  ): Promise<void> {
    if (this._retryStatePersistenceUnavailable) {
      return
    }

    const retryStateDir = this._getSpecRetryStateDirPath()
    try {
      await fs.mkdir(retryStateDir, { recursive: true })
      const retryStatePath = this._getSpecRetryStatePathForCid(cid)
      await fs.writeFile(retryStatePath, JSON.stringify(retryState), 'utf8')
      this._log(
        'trace',
        `[WdioPuppeteerVideoService] Persisted retry state for cid=${cid} at ${retryStatePath} (specFileRetryAttempt=${retryState.specFileRetryAttempt})`,
      )
    } catch (error) {
      this._retryStatePersistenceUnavailable = true
      this._log(
        'warn',
        `[WdioPuppeteerVideoService] Failed to persist retry state for cid=${cid}: ${this._describeError(error)}. Falling back to framework and inferred retry detection only.`,
      )
    }
  }

  private async _readSpecRetryState(
    cid: string,
  ): Promise<PersistedSpecRetryState | undefined> {
    const retryStatePath = this._getSpecRetryStatePathForCid(cid)
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
        `[WdioPuppeteerVideoService] Failed to read retry state for cid=${cid}: ${this._describeError(error)}`,
      )
      return undefined
    }
  }

  private async _deleteSpecRetryState(cid: string): Promise<void> {
    const retryStatePath = this._getSpecRetryStatePathForCid(cid)
    await fs.unlink(retryStatePath).catch((error) => {
      const retryStateError = error as NodeJS.ErrnoException
      if (retryStateError.code === 'ENOENT') {
        return
      }
      this._log(
        'trace',
        `[WdioPuppeteerVideoService] Failed to delete retry state for cid=${cid}: ${this._describeError(error)}`,
      )
    })
  }

  private _resolveGlobalRecordingLockDir(): string {
    return retryState.resolveGlobalRecordingLockDir(
      this._options.outputDir,
      this._options.globalRecordingLockDir,
    )
  }

  private async _releaseRecordingSlot(): Promise<void> {
    await this._releaseGlobalRecordingSlot()
    this._releaseInProcessRecordingSlot()
  }

  private _releaseInProcessRecordingSlot(): void {
    if (!this._ownsRecordingSlot) {
      return
    }

    this._ownsRecordingSlot = false
    if (WdioPuppeteerVideoService._activeRecordingSlots > 0) {
      WdioPuppeteerVideoService._activeRecordingSlots -= 1
    }
    this._log(
      'debug',
      `[WdioPuppeteerVideoService] Released in-process recording slot (${WdioPuppeteerVideoService._activeRecordingSlots}/${this._options.maxConcurrentRecordings ?? 0}).`,
    )

    const nextWaiter = WdioPuppeteerVideoService._recordingSlotWaiters.shift()
    if (nextWaiter) {
      queueMicrotask(nextWaiter)
    }
  }

  private async _releaseGlobalRecordingSlot(): Promise<void> {
    if (!this._ownsGlobalRecordingSlot) {
      return
    }

    const lockPath = this._globalRecordingSlotPath
    const lockFileHandle = this._globalRecordingSlotFileHandle
    this._stopGlobalRecordingSlotHeartbeat()
    this._ownsGlobalRecordingSlot = false
    this._globalRecordingSlotPath = undefined
    this._globalRecordingSlotFileHandle = undefined
    this._globalRecordingSlotStartedAt = undefined

    if (!lockFileHandle) {
      return
    }
    await lockFileHandle.close().catch(() => {
      /* best-effort slot close */
    })
    if (lockPath) {
      await fs.unlink(lockPath).catch(() => {
        /* best-effort slot cleanup */
      })
      this._log(
        'debug',
        `[WdioPuppeteerVideoService] Released global recording slot: ${lockPath}`,
      )
    }
  }

  private _startGlobalRecordingSlotHeartbeat(): void {
    if (
      !this._ownsGlobalRecordingSlot ||
      !this._globalRecordingSlotPath ||
      this._globalRecordingSlotStartedAt === undefined ||
      this._globalRecordingSlotHeartbeatTimer
    ) {
      return
    }

    this._globalRecordingSlotHeartbeatTimer = setInterval(() => {
      void this._refreshGlobalRecordingSlotHeartbeat()
    }, GLOBAL_RECORDING_SLOT_HEARTBEAT_MS)
    this._globalRecordingSlotHeartbeatTimer.unref?.()
  }

  private _stopGlobalRecordingSlotHeartbeat(): void {
    if (!this._globalRecordingSlotHeartbeatTimer) {
      return
    }

    clearInterval(this._globalRecordingSlotHeartbeatTimer)
    this._globalRecordingSlotHeartbeatTimer = undefined
  }

  private async _refreshGlobalRecordingSlotHeartbeat(): Promise<void> {
    const slotPath = this._globalRecordingSlotPath
    const fileHandle = this._globalRecordingSlotFileHandle
    const startedAt = this._globalRecordingSlotStartedAt

    if (
      !this._ownsGlobalRecordingSlot ||
      !slotPath ||
      !fileHandle ||
      startedAt === undefined
    ) {
      return
    }

    const metadataWritten = await this._writeGlobalRecordingSlotMetadata(
      fileHandle,
      startedAt,
    )
    if (!metadataWritten) {
      this._log(
        'trace',
        `[WdioPuppeteerVideoService] Failed to refresh global recording slot heartbeat: ${slotPath}`,
      )
    }
  }

  private _resolveWdioLogLevel(browser: Browser): string | undefined {
    return logging.resolveWdioLogLevel(browser)
  }

  private _normalizeLogLevel(
    level: string | undefined,
  ): WdioPuppeteerVideoServiceLogLevel {
    return logging.normalizeLogLevel(level)
  }

  private _log(
    level: WdioPuppeteerVideoServiceLogLevel,
    message: string,
    details?: unknown,
  ): void {
    logging.writeLog(this._logLevel, level, message, details)
  }

  private _isLogLevelEnabled(
    level: WdioPuppeteerVideoServiceLogLevel,
  ): boolean {
    return logging.shouldLog(level, this._logLevel)
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
    this._recorder = undefined
    this._activeSegment = undefined
    this._currentSegment = 0
    this._currentTestSlug = ''
    this._currentRecordingRetryCount = 0
    this._currentWindowHandle = undefined
    this._recordedSegments.clear()
    await this._releaseRecordingSlot()
  }

  private _isRecordingActive(): boolean {
    return !!this._currentTestSlug || !!this._recorder || !!this._activeSegment
  }

  /** @internal Exposed for unit testing only. */
  private _buildTestSlug(test: Frameworks.Test, context?: unknown): string {
    const metadata = this._collectSlugMetadata(test, context)
    return this._buildTestSlugFromMetadata(metadata)
  }

  private _buildTestSlugFromMetadata(metadata: SlugMetadata): string {
    return buildTestSlugFromMetadata(metadata, {
      maxSlugLength: this._getMaxSlugLength(),
      fileNameStyle: this._options.fileNameStyle ?? 'test',
      fileNameOverflowStrategy:
        this._options.fileNameOverflowStrategy ?? 'truncate',
      sessionIdToken: this._sessionIdToken,
      sessionIdFullToken: this._sessionIdFullToken,
    })
  }

  private _collectSlugMetadata(
    test: Frameworks.Test,
    context: unknown,
  ): SlugMetadata {
    return collectSlugMetadata(test, context, this._options.fileNameStyle)
  }

  private _reserveUniqueSlug(baseSlug: string): string {
    return reserveUniqueSlug(
      baseSlug,
      this._getMaxSlugLength(),
      this._slugUsageCount,
    )
  }

  private _getMaxSlugLength(): number {
    return this._maxSlugLength
  }

  private _computeMaxSlugLength(): number {
    return normalization.computeMaxSlugLength(this._options)
  }

  private _getEffectiveMaxFilenameLength(): number {
    return normalization.getEffectiveMaxFilenameLength(this._options)
  }

  private _sanitizeFileToken(
    value: string | undefined,
    maxLength: number,
  ): string {
    return sanitizeFileToken(value, maxLength)
  }

  private _normalizeOutputDir(outputDir: string | undefined): string {
    return normalization.normalizeOutputDir(outputDir)
  }

  private _normalizeOptionalDir(
    dirPath: string | undefined,
  ): string | undefined {
    return normalization.normalizeOptionalDir(dirPath)
  }

  private _normalizePositiveInt(
    value: number | undefined,
    fallback: number,
  ): number {
    return normalization.normalizePositiveInt(value, fallback)
  }

  private _normalizeNonNegativeInt(
    value: number | undefined,
    fallback: number,
  ): number {
    return normalization.normalizeNonNegativeInt(value, fallback)
  }

  private _normalizeBoolean(
    value: boolean | undefined,
    fallback = false,
  ): boolean {
    return normalization.normalizeBoolean(value, fallback)
  }

  private _normalizePatternList(patterns: string[] | undefined): string[] {
    return normalization.normalizePatternList(patterns)
  }

  private _normalizePostProcessMode(
    mode: WdioPuppeteerVideoServicePostProcessMode | undefined,
  ): WdioPuppeteerVideoServicePostProcessMode {
    return normalization.normalizePostProcessMode(mode)
  }

  private _normalizeOutputFormat(
    format: WdioPuppeteerVideoServiceOptions['outputFormat'] | undefined,
  ): NonNullable<WdioPuppeteerVideoServiceOptions['outputFormat']> {
    return normalization.normalizeOutputFormat(format)
  }

  private _normalizeTranscodeOptions(
    options: WdioPuppeteerVideoServiceTranscodeOptions | undefined,
  ): WdioPuppeteerVideoServiceTranscodeOptions {
    return normalization.normalizeTranscodeOptions(options)
  }

  private _normalizeMergeOptions(
    options: WdioPuppeteerVideoServiceMergeOptions | undefined,
  ): WdioPuppeteerVideoServiceMergeOptions {
    return normalization.normalizeMergeOptions(options)
  }

  private _normalizeFileNameOverflowStrategy(
    strategy: WdioPuppeteerVideoServiceFileNameOverflowStrategy | undefined,
  ): WdioPuppeteerVideoServiceFileNameOverflowStrategy {
    return normalization.normalizeFileNameOverflowStrategy(strategy)
  }

  private _normalizeFileNameStyle(
    style: WdioPuppeteerVideoServiceFileNameStyle | undefined,
  ): WdioPuppeteerVideoServiceFileNameStyle {
    return normalization.normalizeFileNameStyle(style)
  }

  private _normalizeMp4Mode(
    mode: WdioPuppeteerVideoServiceMp4Mode | undefined,
  ): WdioPuppeteerVideoServiceMp4Mode {
    return normalization.normalizeMp4Mode(mode)
  }

  private _normalizePerformanceProfile(
    profile: WdioPuppeteerVideoServicePerformanceProfile | undefined,
  ): WdioPuppeteerVideoServicePerformanceProfile {
    return normalization.normalizePerformanceProfile(profile)
  }

  private _normalizeRecordingStartMode(
    mode: WdioPuppeteerVideoServiceRecordingStartMode | undefined,
  ): WdioPuppeteerVideoServiceRecordingStartMode {
    return normalization.normalizeRecordingStartMode(mode)
  }

  private _isBenignStreamWriteError(error: NodeJS.ErrnoException): boolean {
    return normalization.isBenignStreamWriteError(error)
  }

  private _describeError(error: unknown): string {
    return normalization.describeError(error)
  }

  private _nextPageMarkerId(): string {
    this._pageMarkerCounter += 1
    const sessionToken =
      this._sessionIdToken || this._sessionIdFullToken || 'session'
    return `wdio-video-${sessionToken}-${Date.now().toString(36)}-${this._pageMarkerCounter.toString(36)}`
  }

  private _buildSessionIdToken(sessionId: string | undefined): string {
    return buildSessionIdToken(sessionId)
  }

  private _buildFullSessionIdToken(sessionId: string | undefined): string {
    return buildFullSessionIdToken(sessionId)
  }
}
