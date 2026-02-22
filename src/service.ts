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
  type DeferredMergeTask,
  type DeferredPostProcessTask,
  type DeferredTranscodeTask,
  FFMPEG_CHECK_TIMEOUT_MS,
  GLOBAL_RECORDING_SLOT_POLL_MS,
  GLOBAL_RECORDING_SLOT_TIMEOUT_MS,
  type MergeExecutionOptions,
  MP4_DIRECT_PROBE_TIMEOUT_MS,
  type OutputFormat,
  type PersistedSpecRetryState,
  type ResolvedRetryContext,
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
  private _recorder?: ScreenRecorder
  private _activeSegment?: ActiveSegment
  private _currentSegment = 0
  private _currentTestSlug = ''
  private _currentRecordingRetryCount = 0
  private readonly _recordedSegments = new Set<string>()
  private readonly _entityAttemptCount = new Map<string, number>()
  private _specFileRetryAttempt = 0
  private readonly _launcherSpecRetryAttemptCount = new Map<string, number>()
  private _isChromium = false
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
  private readonly _wildcardPatternRegexCache = new Map<string, RegExp>()
  private _pageMarkerCounter = 0

  constructor(options: WdioPuppeteerVideoServiceOptions) {
    this._hasExplicitLogLevel = typeof options.logLevel === 'string'
    this._logLevel = this._normalizeLogLevel(options.logLevel)
    const performanceProfile = this._normalizePerformanceProfile(
      options.performanceProfile,
    )

    const transcodeOptions = options.transcode ?? {}
    const mergedTranscode: WdioPuppeteerVideoServiceTranscodeOptions = {
      deleteOriginal: true,
      ...transcodeOptions,
    }
    const mergeOptions = options.mergeSegments ?? {}
    const mergedMergeSegments: WdioPuppeteerVideoServiceMergeOptions = {
      deleteSegments: true,
      ...mergeOptions,
    }

    const legacyFfmpegArgs = (options as unknown as { ffmpegArgs?: string[] })
      .ffmpegArgs
    if (legacyFfmpegArgs !== undefined) {
      mergedTranscode.ffmpegArgs ??= legacyFfmpegArgs
      this._log(
        'warn',
        '[WdioPuppeteerVideoService] `ffmpegArgs` is deprecated. Use `transcode.ffmpegArgs` instead.',
      )
    }

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
        outputFormat: options.outputFormat ?? 'webm',
      }

      if (options.mergeSegments?.enabled === undefined) {
        mergedOptions.mergeSegments = {
          ...mergedMergeSegments,
          enabled: false,
        }
      }
    }

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
      performanceProfile: this._normalizePerformanceProfile(
        mergedOptions.performanceProfile,
      ),
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
      globalRecordingLockDir: this._normalizeOptionalDir(
        mergedOptions.globalRecordingLockDir,
      ),
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
    await fs.mkdir(retryStateDir, { recursive: true })
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

    this._ffmpegCandidates = this._getFfmpegCandidates()
    this._resolvedFfmpegPath = await this._resolveAvailableFfmpegPath(
      this._ffmpegCandidates,
    )
    this._ffmpegAvailable = !!this._resolvedFfmpegPath
    if (this._ffmpegAvailable) {
      this._log(
        'info',
        `[WdioPuppeteerVideoService] Using ffmpeg binary: ${this._resolvedFfmpegPath}`,
      )
      await this._configureMp4RecordingMode()
    } else {
      this._warnMissingFfmpeg('Video recording is disabled for this worker.')
    }

    await fs.mkdir(this._options.outputDir ?? DEFAULT_OUTPUT_DIR, {
      recursive: true,
    })
  }

  async beforeTest(test: Frameworks.Test, context: unknown): Promise<void> {
    if (!this._isChromium || !this._browser || !this._ffmpegAvailable) {
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
    if (!this._isChromium || !this._browser || !this._ffmpegAvailable) {
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
          this._resetTestState()
        }
      }

      await this._flushDeferredPostProcessTasks()
      this._entityAttemptCount.clear()
      this._specHadFailure = false
    })
  }

  async beforeCommand(commandName: string): Promise<void> {
    if (!this._isChromium || !this._browser || !this._ffmpegAvailable) {
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
    if (!this._isChromium || !this._browser || !this._ffmpegAvailable) {
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

  private async _startRecording(): Promise<void> {
    if (
      !this._browser ||
      !this._currentTestSlug ||
      this._recorder ||
      !this._ffmpegAvailable
    ) {
      return
    }

    let acquiredRecordingSlot = false
    try {
      const puppeteerBrowser =
        (await this._browser.getPuppeteer()) as unknown as PuppeteerBrowser
      const windowHandle = await this._browser
        .getWindowHandle()
        .catch(() => undefined /* window may already be closed */)

      const targetId = this._nextPageMarkerId()
      await this._browser.execute((id: string) => {
        const win = globalThis as unknown as { _wdio_video_id?: string }
        win._wdio_video_id = id
      }, targetId)

      const page = await this._findActivePage(puppeteerBrowser, targetId)
      if (!page) {
        this._log(
          'warn',
          '[WdioPuppeteerVideoService] Could not find puppeteer page match. Recording skipped.',
        )
        return
      }

      await page.bringToFront().catch(() => {
        /* best-effort focus */
      })
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

      const recordingPath = this._getSegmentPath(recordingFormat)
      const outputPath = this._getSegmentPath(outputFormat)

      const acquiredSlot = await this._acquireRecordingSlot()
      if (!acquiredSlot) {
        this._log(
          'warn',
          '[WdioPuppeteerVideoService] Recording slot acquisition timed out. Recording skipped for this segment.',
        )
        return
      }
      acquiredRecordingSlot = true

      const ffmpegPath = this._resolveFfmpegPath()
      const recorder = await page.screencast({
        format: recordingFormat,
        fps: this._options.fps || 30,
        ffmpegPath,
      })

      const writeStream = createWriteStream(recordingPath)
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

      this._recorder = recorder
      this._activeSegment = {
        recordingPath,
        outputPath,
        outputFormat,
        recordingFormat,
        transcode: transcodeEnabled,
        transcodeOptions: {
          deleteOriginal: this._options.transcode?.deleteOriginal ?? true,
          ffmpegArgs: this._options.transcode?.ffmpegArgs,
        },
        writeStream,
        writeStreamDone,
        writeStreamErrored: false,
        writeStreamErrorMessage: undefined,
        onWriteStreamError,
        onRecorderError,
      }
      activeSegmentRef = this._activeSegment

      this._currentWindowHandle = windowHandle
      this._log(
        'debug',
        `[WdioPuppeteerVideoService] Recording segment ${this._currentSegment} to ${outputPath}`,
      )

      await this._kickOffScreencastFramesIfEnabled(page)
    } catch (e) {
      if (acquiredRecordingSlot && !this._recorder) {
        this._releaseRecordingSlot()
      }
      this._log(
        'error',
        '[WdioPuppeteerVideoService] Failed to start recording:',
        e,
      )
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
    const testName = metadata.testNameToken
    this._log(
      'debug',
      `[WdioPuppeteerVideoService] Starting test recording: ${testName}`,
    )
    const baseSlug = this._buildTestSlugFromMetadata(metadata)
    this._currentTestSlug = this._reserveUniqueSlug(baseSlug)
    this._currentSegment = 1
    this._currentRecordingRetryCount = retryCount
    this._recordedSegments.clear()
    this._currentWindowHandle = undefined
    this._activeSegment = undefined

    await this._startRecording()
  }

  private async _startSpecLevelRecording(retryCount: number): Promise<void> {
    const specMetadata = this._buildSpecLevelSlugMetadata(retryCount)
    const specEntity = {
      title: specMetadata.testNameToken,
      fullTitle: specMetadata.testNameToken,
      file: specMetadata.fileToken,
    } as Frameworks.Test

    await this._startRecordingForEntity(
      specEntity,
      { uri: this._specPaths[0] },
      retryCount,
    )
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
    if (!this._options.recordOnRetries) {
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
    if (!this._options.recordOnRetries) {
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
      this._resetTestState()
      return
    }

    if (this._options.mergeSegments?.enabled) {
      if (this._shouldDeferPostProcessing()) {
        await this._queueDeferredMergeForCurrentTest()
      } else {
        await this._mergeSegmentsForCurrentTest()
      }
    }

    this._resetTestState()
  }

  private async _stopRecording(): Promise<void> {
    const recorder = this._recorder
    const activeSegment = this._activeSegment
    this._recorder = undefined
    this._activeSegment = undefined

    if (!recorder || !activeSegment) {
      this._releaseRecordingSlot()
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
        activeSegment.transcode = false
        activeSegment.outputPath = activeSegment.recordingPath
        activeSegment.outputFormat = activeSegment.recordingFormat
      }

      await this._finalizeSegment(activeSegment)
      this._log(
        'debug',
        `[WdioPuppeteerVideoService] Finalized segment ${this._currentSegment} (${activeSegment.outputPath})`,
      )
    } finally {
      recorder.off('error', activeSegment.onRecorderError)
      activeSegment.writeStream.off('error', activeSegment.onWriteStreamError)
      this._releaseRecordingSlot()
    }
  }

  private async _deleteSegments(): Promise<void> {
    const filesToDelete = [...this._recordedSegments]
    for (const file of filesToDelete) {
      try {
        await fs.unlink(file)
      } catch {
        // Ignore if file doesn't exist
      }
    }
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

    const transcodeAfterMerge =
      mergedFormat === 'webm' &&
      this._options.outputFormat === 'mp4' &&
      this._shouldTranscode('mp4')
        ? {
            outputPath: this._getMergedOutputPath('mp4'),
            deleteOriginal: this._options.transcode?.deleteOriginal ?? true,
            ffmpegArgs: this._options.transcode?.ffmpegArgs,
          }
        : undefined
    const mergedPath = transcodeAfterMerge
      ? this._getMergedOutputPath('webm')
      : this._getMergedOutputPath(mergedFormat)

    this._dropDeferredPostProcessTasksForPaths(segmentPaths)
    this._deferredPostProcessTasks.push({
      kind: 'merge',
      segmentPaths,
      mergedPath,
      deleteSegments,
      transcodeToMp4: transcodeAfterMerge,
    })
    this._log(
      'debug',
      `[WdioPuppeteerVideoService] Queued deferred merge for ${segmentPaths.length} segments into ${mergedPath}.`,
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
    const {
      segmentPaths,
      mergedPath,
      deleteSegments,
      writeFailureContext,
      ffmpegOperation,
    } = options
    if (segmentPaths.length === 0) {
      return false
    }

    await fs.unlink(mergedPath).catch(() => {
      /* may not exist yet */
    })

    if (segmentPaths.length === 1) {
      if (deleteSegments) {
        await fs.rename(segmentPaths[0], mergedPath).catch(async () => {
          await fs.copyFile(segmentPaths[0], mergedPath)
          await fs.unlink(segmentPaths[0]).catch(() => {
            /* best-effort cleanup */
          })
        })
      } else {
        await fs.copyFile(segmentPaths[0], mergedPath)
      }
      return true
    }

    const concatListPath = path.join(
      this._options.outputDir || DEFAULT_OUTPUT_DIR,
      `${path.parse(mergedPath).name}_concat_${Date.now().toString(36)}.txt`,
    )

    const wroteConcatList = await fs
      .writeFile(concatListPath, this._buildConcatList(segmentPaths), 'utf8')
      .then(() => true)
      .catch((error: unknown) => {
        this._log(
          'warn',
          `[WdioPuppeteerVideoService] Failed to write ${writeFailureContext} input list: ${String(error)}`,
        )
        return false
      })
    if (!wroteConcatList) {
      return false
    }

    const merged = await this._runFfmpeg(
      [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatListPath,
        '-c',
        'copy',
        mergedPath,
      ],
      ffmpegOperation,
    )

    await fs.unlink(concatListPath).catch(() => {
      /* best-effort cleanup */
    })
    if (!merged) {
      return false
    }

    if (deleteSegments) {
      for (const segmentPath of segmentPaths) {
        await fs.unlink(segmentPath).catch(() => {
          /* best-effort cleanup */
        })
      }
    }

    return true
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

  private _buildConcatList(segmentPaths: string[]): string {
    return artifactPaths.buildConcatList(segmentPaths)
  }

  private _resolveFfmpegPath(): string {
    const configuredPath = this._options.ffmpegPath?.trim()
    const envPath = process.env.FFMPEG_PATH?.trim()
    return this._resolvedFfmpegPath || configuredPath || envPath || 'ffmpeg'
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
      await segment.writeStreamDone.catch(() => {
        /* already errored */
      })
      return false
    }

    const ok = await Promise.race([
      segment.writeStreamDone.then(() => true).catch(() => false),
      delay(WRITE_STREAM_TIMEOUT_MS).then(() => false),
    ])

    if (!ok) {
      this._log(
        'warn',
        `[WdioPuppeteerVideoService] Timed out waiting for recording stream to finish: ${segment.recordingPath}`,
      )
      return false
    }

    return true
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

      this._deferredPostProcessTasks.push({
        kind: 'transcode',
        inputPath: segment.recordingPath,
        outputPath: segment.outputPath,
        deleteOriginal: segment.transcodeOptions.deleteOriginal,
        ffmpegArgs: segment.transcodeOptions.ffmpegArgs,
      })
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
    const args = [
      '-y',
      '-i',
      inputPath,
      '-an',

      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      ...(ffmpegArgs ?? []),
      outputPath,
    ]

    return this._runFfmpeg(args, 'transcode')
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
      const proc = spawn(ffmpegPath, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''

      proc.stderr?.on('data', (chunk) => {
        const next = stderr + chunk.toString('utf8')
        stderr = next.length > 32_768 ? next.slice(-32_768) : next
      })

      proc.on('error', (error) => {
        this._ffmpegAvailable = false
        this._warnMissingFfmpeg(
          `ffmpeg ${operation} failed to start: ${error.message}`,
        )
        this._log(
          'warn',
          `[WdioPuppeteerVideoService] Failed to spawn ffmpeg for ${operation}: ${error.message}`,
        )
        resolve(false)
      })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(true)
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
        resolve(false)
      })
    })
  }

  private async _resolveAvailableFfmpegPath(
    candidates: string[],
  ): Promise<string | undefined> {
    for (const candidate of candidates) {
      const available = await this._canExecuteFfmpeg(candidate)
      if (available) {
        return candidate
      }
    }
    return undefined
  }

  private _getFfmpegCandidates(): string[] {
    return ffmpeg.getFfmpegCandidates(
      this._options.ffmpegPath?.trim(),
      process.env.FFMPEG_PATH?.trim(),
    )
  }

  private async _canExecuteFfmpeg(ffmpegPath: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const proc = spawn(ffmpegPath, ['-version'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      })
      let settled = false
      const settle = (available: boolean) => {
        if (settled) {
          return
        }
        settled = true
        resolve(available)
      }

      const timer = setTimeout(() => {
        proc.kill()
        settle(false)
      }, FFMPEG_CHECK_TIMEOUT_MS)

      proc.on('error', () => {
        clearTimeout(timer)
        settle(false)
      })

      proc.on('close', (code) => {
        clearTimeout(timer)
        settle(code === 0)
      })
    })
  }

  private async _supportsDirectMp4(ffmpegPath: string): Promise<boolean> {
    const outputTarget = process.platform === 'win32' ? 'NUL' : '/dev/null'
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=16x16:r=1',
      '-frames:v',
      '1',
      '-c:v',
      'mpeg4',
      '-movflags',
      '+frag_keyframe+empty_moov+default_base_moof+hybrid_fragmented',
      '-f',
      'mp4',
      '-y',
      outputTarget,
    ]

    return new Promise<boolean>((resolve) => {
      const proc = spawn(ffmpegPath, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      let settled = false
      const settle = (value: boolean) => {
        if (settled) {
          return
        }
        settled = true
        resolve(value)
      }

      const timer = setTimeout(() => {
        proc.kill()
        settle(false)
      }, MP4_DIRECT_PROBE_TIMEOUT_MS)

      proc.stderr?.on('data', (chunk) => {
        const next = stderr + chunk.toString('utf8')
        stderr = next.length > 8_192 ? next.slice(-8_192) : next
      })

      proc.on('error', () => {
        clearTimeout(timer)
        settle(false)
      })

      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) {
          settle(true)
          return
        }

        const details = stderr.trim()
        if (details.length > 0) {
          this._log(
            'debug',
            `[WdioPuppeteerVideoService] Direct MP4 probe failed: ${details}`,
          )
        }
        settle(false)
      })
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

    await this._executeDeferredTranscodeTask({
      kind: 'transcode',
      inputPath: task.mergedPath,
      outputPath: task.transcodeToMp4.outputPath,
      deleteOriginal: task.transcodeToMp4.deleteOriginal,
      ffmpegArgs: task.transcodeToMp4.ffmpegArgs,
    })
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

    await this._acquireInProcessRecordingSlot()
    const globalSlotAcquired = await this._acquireGlobalRecordingSlot()
    if (globalSlotAcquired) {
      return true
    }

    this._releaseInProcessRecordingSlot()
    return false
  }

  private async _acquireInProcessRecordingSlot(): Promise<void> {
    const maxConcurrentRecordings = this._options.maxConcurrentRecordings ?? 0
    if (maxConcurrentRecordings <= 0 || this._ownsRecordingSlot) {
      return
    }

    await new Promise<void>((resolve) => {
      const tryAcquire = () => {
        if (
          WdioPuppeteerVideoService._activeRecordingSlots <
          maxConcurrentRecordings
        ) {
          WdioPuppeteerVideoService._activeRecordingSlots += 1
          this._ownsRecordingSlot = true
          resolve()
          return
        }

        WdioPuppeteerVideoService._recordingSlotWaiters.push(tryAcquire)
      }

      tryAcquire()
    })
  }

  private async _acquireGlobalRecordingSlot(): Promise<boolean> {
    const maxGlobalRecordings = this._options.maxGlobalRecordings ?? 0
    if (maxGlobalRecordings <= 0 || this._ownsGlobalRecordingSlot) {
      return true
    }

    const lockDir = this._resolveGlobalRecordingLockDir()
    await fs.mkdir(lockDir, { recursive: true }).catch(() => {
      /* best-effort lock-dir creation */
    })

    const startedAt = Date.now()
    while (Date.now() - startedAt < GLOBAL_RECORDING_SLOT_TIMEOUT_MS) {
      const acquired = await this._tryAcquireGlobalRecordingSlot(
        lockDir,
        maxGlobalRecordings,
      )
      if (acquired) {
        return true
      }
      await delay(GLOBAL_RECORDING_SLOT_POLL_MS)
    }

    return false
  }

  private async _tryAcquireGlobalRecordingSlot(
    lockDir: string,
    maxGlobalRecordings: number,
  ): Promise<boolean> {
    for (let slotIndex = 1; slotIndex <= maxGlobalRecordings; slotIndex += 1) {
      const slotPath = path.join(lockDir, `slot-${slotIndex}.lock`)
      try {
        const fileHandle = await fs.open(slotPath, 'wx')
        this._ownsGlobalRecordingSlot = true
        this._globalRecordingSlotPath = slotPath
        this._globalRecordingSlotFileHandle = fileHandle
        await fileHandle
          .writeFile(
            JSON.stringify({
              pid: process.pid,
              startedAt: Date.now(),
            }),
            'utf8',
          )
          .catch(() => {
            /* best-effort slot metadata */
          })
        return true
      } catch (error) {
        const slotError = error as NodeJS.ErrnoException
        if (slotError.code === 'EEXIST') {
          await this._cleanupStaleGlobalRecordingSlot(slotPath)
        }
      }
    }

    return false
  }

  private async _cleanupStaleGlobalRecordingSlot(
    slotPath: string,
  ): Promise<void> {
    const fileContents = await fs.readFile(slotPath, 'utf8').catch(() => '')
    const parsedPid = this._extractPidFromSlotFile(fileContents)
    if (!parsedPid || this._isProcessAlive(parsedPid)) {
      return
    }

    await fs.unlink(slotPath).catch(() => {
      /* best-effort stale-slot cleanup */
    })
  }

  private _extractPidFromSlotFile(fileContents: string): number | undefined {
    return retryState.extractPidFromSlotFile(fileContents)
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
    const retryStateDir = this._getSpecRetryStateDirPath()
    await fs.mkdir(retryStateDir, { recursive: true })
    const retryStatePath = this._getSpecRetryStatePathForCid(cid)
    await fs.writeFile(retryStatePath, JSON.stringify(retryState), 'utf8')
    this._log(
      'trace',
      `[WdioPuppeteerVideoService] Persisted retry state for cid=${cid} at ${retryStatePath} (specFileRetryAttempt=${retryState.specFileRetryAttempt})`,
    )
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

  private _releaseRecordingSlot(): void {
    this._releaseGlobalRecordingSlot()
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

    const nextWaiter = WdioPuppeteerVideoService._recordingSlotWaiters.shift()
    if (nextWaiter) {
      queueMicrotask(nextWaiter)
    }
  }

  private _releaseGlobalRecordingSlot(): void {
    if (!this._ownsGlobalRecordingSlot) {
      return
    }

    const lockPath = this._globalRecordingSlotPath
    const lockFileHandle = this._globalRecordingSlotFileHandle
    this._ownsGlobalRecordingSlot = false
    this._globalRecordingSlotPath = undefined
    this._globalRecordingSlotFileHandle = undefined

    lockFileHandle
      ?.close()
      .catch(() => {
        /* best-effort slot close */
      })
      .finally(async () => {
        if (!lockPath) {
          return
        }
        await fs.unlink(lockPath).catch(() => {
          /* best-effort slot cleanup */
        })
      })
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

  private _resetTestState(): void {
    this._recorder = undefined
    this._activeSegment = undefined
    this._currentSegment = 0
    this._currentTestSlug = ''
    this._currentRecordingRetryCount = 0
    this._currentWindowHandle = undefined
    this._recordedSegments.clear()
    this._releaseRecordingSlot()
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
    return collectSlugMetadata(test, context)
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
