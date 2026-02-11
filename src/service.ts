import { spawn } from 'node:child_process'
import type { WriteStream } from 'node:fs'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
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
import type {
  WdioPuppeteerVideoServiceFileNameOverflowStrategy,
  WdioPuppeteerVideoServiceFileNameStyle,
  WdioPuppeteerVideoServiceLogLevel,
  WdioPuppeteerVideoServiceMergeOptions,
  WdioPuppeteerVideoServiceMp4Mode,
  WdioPuppeteerVideoServiceOptions,
  WdioPuppeteerVideoServicePerformanceProfile,
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

type OutputFormat = NonNullable<
  WdioPuppeteerVideoServiceOptions['outputFormat']
>

interface ActiveSegment {
  recordingPath: string
  outputPath: string
  outputFormat: OutputFormat
  recordingFormat: OutputFormat
  transcode: boolean
  transcodeOptions: Required<
    Pick<WdioPuppeteerVideoServiceTranscodeOptions, 'deleteOriginal'>
  > &
    Pick<WdioPuppeteerVideoServiceTranscodeOptions, 'ffmpegArgs'>
  writeStream: WriteStream
  writeStreamDone: Promise<void>
  writeStreamErrored: boolean
  writeStreamErrorMessage?: string
  onWriteStreamError: (error: NodeJS.ErrnoException) => void
  onRecorderError: (error: unknown) => void
}

const WINDOW_SEGMENT_COMMANDS = new Set([
  'switchWindow',
  'switchToWindow',
  'newWindow',
  'closeWindow',
])
const ACTIVE_PAGE_TIMEOUT_MS = 2_000
const ACTIVE_PAGE_POLL_MS = 50
const SEGMENT_SWITCH_DELAY_MS = 50
const WRITE_STREAM_TIMEOUT_MS = 30_000
const FFMPEG_CHECK_TIMEOUT_MS = 5_000
const WINDOWS_DEFAULT_MAX_FILENAME_LENGTH = 180
const DEFAULT_MAX_FILENAME_LENGTH = 255
const WINDOWS_MAX_PATH_LENGTH = 259
const SEGMENT_SUFFIX_MAX_LENGTH = '_part9999.webm'.length
const MIN_SAFE_FILENAME_LENGTH = 40
const MP4_DIRECT_PROBE_TIMEOUT_MS = 5_000
const require = createRequire(import.meta.url)
const DEFAULT_OUTPUT_DIR = 'videos'
const LOG_LEVEL_PRIORITY: Record<WdioPuppeteerVideoServiceLogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
}
const LOG_METHOD_MAP: Record<string, (...args: unknown[]) => void> = {
  error: console.error,
  warn: console.warn,
  info: console.info,
}

/**
 * WebdriverIO Service to record videos using Puppeteer and FFmpeg
 */
export default class WdioPuppeteerVideoService
  implements Services.ServiceInstance
{
  private _browser?: Browser
  private readonly _options: WdioPuppeteerVideoServiceOptions
  private _recorder?: ScreenRecorder
  private _activeSegment?: ActiveSegment
  private _currentSegment = 0
  private _currentTestSlug = ''
  private readonly _recordedSegments = new Set<string>()
  private _isChromium = false
  private _currentWindowHandle: string | undefined
  private _sessionIdToken = ''
  private _sessionIdFullToken = ''
  private _logLevel: WdioPuppeteerVideoServiceLogLevel = 'warn'
  private readonly _hasExplicitLogLevel: boolean
  private _ffmpegAvailable = false
  private _resolvedFfmpegPath: string | undefined
  private _ffmpegCandidates: string[] = []
  private _recordingTask: Promise<void> = Promise.resolve()
  private _warnedAboutMp4Compatibility = false
  private _warnedAboutMp4AutoFallback = false
  private _warnedAboutMissingFfmpeg = false
  private _forceMp4Transcode = false
  private readonly _slugUsageCount = new Map<string, number>()
  private readonly _maxSlugLength: number
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

    if (options.ffmpegArgs) {
      mergedTranscode.ffmpegArgs ??= options.ffmpegArgs
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
    }

    this._maxSlugLength = this._computeMaxSlugLength()
  }

  async before(
    _capabilities: WebdriverIO.Capabilities,
    _specs: string[],
    browser: Browser,
  ): Promise<void> {
    this._browser = browser

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
      await this._startRecordingForEntity(test, context)
    })
  }

  async afterTest(
    _test: Frameworks.Test,
    _context: unknown,
    result: Frameworks.TestResult,
  ): Promise<void> {
    await this._finalizeIfRecording(result.passed)
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
      await this._startRecordingForEntity(cucumberEntity, context ?? world)
    })
  }

  async afterScenario(
    _world: Frameworks.World,
    result: Frameworks.PickleResult,
  ): Promise<void> {
    await this._finalizeIfRecording(result.passed)
  }

  async after(): Promise<void> {
    if (!this._isRecordingActive()) {
      return
    }

    await this._runSerializedRecordingTask(async () => {
      await this._stopRecording()
      this._resetTestState()
    })
  }

  async beforeCommand(commandName: string): Promise<void> {
    if (!this._isChromium || !this._browser || !this._ffmpegAvailable) {
      return
    }

    if (!this._currentTestSlug) {
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

      await this._kickOffScreencastFrames(page)
    } catch (e) {
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
  ): Promise<void> {
    if (this._currentTestSlug) {
      return
    }

    const metadata = this._collectSlugMetadata(test, context)
    const testName = metadata.testNameToken
    this._log(
      'debug',
      `[WdioPuppeteerVideoService] Starting test recording: ${testName}`,
    )
    const baseSlug = this._buildTestSlugFromMetadata(metadata)
    this._currentTestSlug = this._reserveUniqueSlug(baseSlug)
    this._currentSegment = 1
    this._recordedSegments.clear()
    this._currentWindowHandle = undefined
    this._activeSegment = undefined

    await this._startRecording()
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

    const shouldKeepArtifacts = !passed || !!this._options.saveAllVideos
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
      await this._mergeSegmentsForCurrentTest()
    }

    this._resetTestState()
  }

  private async _stopRecording(): Promise<void> {
    const recorder = this._recorder
    const activeSegment = this._activeSegment
    this._recorder = undefined
    this._activeSegment = undefined

    if (!recorder || !activeSegment) {
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
    }
  }

  private async _deleteSegments(): Promise<void> {
    for (const file of this._recordedSegments) {
      try {
        await fs.unlink(file)
      } catch {
        // Ignore if file doesn't exist
      }
    }
    this._recordedSegments.clear()
  }

  private async _mergeSegmentsForCurrentTest(): Promise<void> {
    if (!this._currentTestSlug) {
      return
    }

    const segmentPrefix = `${this._currentTestSlug}_part`
    const segmentPaths = [...this._recordedSegments]
      .filter((filePath) => path.basename(filePath).startsWith(segmentPrefix))
      .sort(
        (leftPath, rightPath) =>
          this._extractPartNumber(leftPath) -
          this._extractPartNumber(rightPath),
      )

    if (segmentPaths.length === 0) {
      return
    }

    const deleteSegments = this._options.mergeSegments?.deleteSegments ?? true
    const extension = path.extname(segmentPaths[0]).toLowerCase()
    const extensionToFormat: Record<string, OutputFormat> = {
      '.mp4': 'mp4',
      '.webm': 'webm',
    }
    const mergedFormat: OutputFormat | undefined = extensionToFormat[extension]

    if (!mergedFormat) {
      this._log(
        'warn',
        `[WdioPuppeteerVideoService] Unsupported segment format for merge: ${extension}`,
      )
      return
    }

    const mixedFormats = segmentPaths.some(
      (filePath) => path.extname(filePath).toLowerCase() !== extension,
    )
    if (mixedFormats) {
      this._log(
        'warn',
        '[WdioPuppeteerVideoService] Skipping merge because segment formats are mixed.',
      )
      return
    }

    const mergedPath = this._getMergedOutputPath(mergedFormat)
    this._log(
      'debug',
      `[WdioPuppeteerVideoService] Attempting merge for ${segmentPaths.length} segments into ${mergedPath}`,
    )

    if (segmentPaths.length === 1) {
      await fs.unlink(mergedPath).catch(() => {
        /* may not exist yet */
      })

      if (deleteSegments) {
        await fs.rename(segmentPaths[0], mergedPath).catch(async () => {
          await fs.copyFile(segmentPaths[0], mergedPath)
          await fs.unlink(segmentPaths[0]).catch(() => {
            /* best-effort cleanup */
          })
        })
        this._recordedSegments.clear()
      } else {
        await fs.copyFile(segmentPaths[0], mergedPath)
      }

      this._recordedSegments.add(mergedPath)
      return
    }

    const concatListPath = path.join(
      this._options.outputDir || DEFAULT_OUTPUT_DIR,
      `${this._currentTestSlug}_concat_${Date.now().toString(36)}.txt`,
    )

    await fs
      .writeFile(concatListPath, this._buildConcatList(segmentPaths), 'utf8')
      .catch((error: unknown) => {
        this._log(
          'warn',
          `[WdioPuppeteerVideoService] Failed to write merge input list: ${String(error)}`,
        )
      })

    const hasConcatList = await fs
      .stat(concatListPath)
      .then(() => true)
      .catch(() => false)
    if (!hasConcatList) {
      return
    }

    await fs.unlink(mergedPath).catch(() => {
      /* may not exist yet */
    })

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
      'segment merge',
    )

    await fs.unlink(concatListPath).catch(() => {
      /* best-effort cleanup */
    })

    if (!merged) {
      return
    }

    this._recordedSegments.add(mergedPath)

    if (!deleteSegments) {
      return
    }

    for (const filePath of segmentPaths) {
      await fs.unlink(filePath).catch(() => {
        /* best-effort cleanup */
      })
      this._recordedSegments.delete(filePath)
    }
  }

  private _getSegmentPath(format?: OutputFormat): string {
    const resolvedFormat = format ?? this._options.outputFormat ?? 'webm'
    const fileStem = this._currentTestSlug || 'test'
    const filename = `${fileStem}_part${this._currentSegment}.${resolvedFormat}`
    return path.join(this._options.outputDir || DEFAULT_OUTPUT_DIR, filename)
  }

  private _getMergedOutputPath(format?: OutputFormat): string {
    const resolvedFormat = format ?? this._options.outputFormat ?? 'webm'
    const fileStem = this._currentTestSlug || 'test'
    const filename = `${fileStem}.${resolvedFormat}`
    return path.join(this._options.outputDir || DEFAULT_OUTPUT_DIR, filename)
  }

  private _extractPartNumber(filePath: string): number {
    const partMatch = new RegExp(/_part(\d+)\./).exec(path.basename(filePath))
    if (!partMatch) {
      return Number.MAX_SAFE_INTEGER
    }

    return Number.parseInt(partMatch[1], 10)
  }

  private _buildConcatList(segmentPaths: string[]): string {
    return segmentPaths
      .map((filePath) => {
        const normalizedPath = path.resolve(filePath).replaceAll('\\', '/')
        const escapedPath = normalizedPath.replaceAll("'", String.raw`'\''`)
        return `file '${escapedPath}'`
      })
      .join('\n')
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
      ...(segment.transcodeOptions.ffmpegArgs ?? []),
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
    const configuredPath = this._options.ffmpegPath?.trim()
    const envPath = process.env.FFMPEG_PATH?.trim()
    const ffmpegStaticPath = this._resolveOptionalFfmpegStaticPath()

    const candidates = [configuredPath, envPath, 'ffmpeg', ffmpegStaticPath]
    const uniqueCandidates: string[] = []
    const seen = new Set<string>()

    for (const candidate of candidates) {
      if (!candidate) {
        continue
      }

      const normalizedCandidate = candidate.trim()
      if (!normalizedCandidate || seen.has(normalizedCandidate)) {
        continue
      }

      seen.add(normalizedCandidate)
      uniqueCandidates.push(normalizedCandidate)
    }

    return uniqueCandidates
  }

  private _resolveOptionalFfmpegStaticPath(): string | undefined {
    try {
      const resolved = require('ffmpeg-static') as string | null
      if (typeof resolved === 'string' && resolved.trim().length > 0) {
        return resolved
      }
    } catch {
      // optional dependency
    }
    return undefined
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

  private _resolveWdioLogLevel(browser: Browser): string | undefined {
    const browserWithOptions = browser as Browser & {
      options?: { logLevel?: string }
      config?: { logLevel?: string }
    }

    return (
      browserWithOptions.options?.logLevel ||
      browserWithOptions.config?.logLevel ||
      process.env.WDIO_LOG_LEVEL
    )
  }

  private _normalizeLogLevel(
    level: string | undefined,
  ): WdioPuppeteerVideoServiceLogLevel {
    const normalized = (level || '').toLowerCase()
    if (normalized in LOG_LEVEL_PRIORITY) {
      return normalized as WdioPuppeteerVideoServiceLogLevel
    }
    return 'warn'
  }

  private _shouldLog(level: WdioPuppeteerVideoServiceLogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[this._logLevel]
  }

  private _formatLogMessage(message: string): string {
    const prefix = '[WdioPuppeteerVideoService]'
    if (message.startsWith(prefix)) {
      return message
    }

    return `${prefix} ${message}`
  }

  private _log(
    level: WdioPuppeteerVideoServiceLogLevel,
    message: string,
    details?: unknown,
  ): void {
    if (!this._shouldLog(level)) {
      return
    }

    const formattedMessage = this._formatLogMessage(message)
    const logMethod = LOG_METHOD_MAP[level] ?? console.debug

    if (details === undefined) {
      logMethod(formattedMessage)
    } else {
      logMethod(formattedMessage, details)
    }
  }

  private _resetTestState(): void {
    this._recorder = undefined
    this._activeSegment = undefined
    this._currentSegment = 0
    this._currentTestSlug = ''
    this._currentWindowHandle = undefined
    this._recordedSegments.clear()
  }

  private _isRecordingActive(): boolean {
    return this._isChromium && this._ffmpegAvailable
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
    const effectiveMaxFilenameLength = this._getEffectiveMaxFilenameLength()
    return Math.max(16, effectiveMaxFilenameLength - SEGMENT_SUFFIX_MAX_LENGTH)
  }

  private _getEffectiveMaxFilenameLength(): number {
    const platformDefault =
      process.platform === 'win32'
        ? WINDOWS_DEFAULT_MAX_FILENAME_LENGTH
        : DEFAULT_MAX_FILENAME_LENGTH
    const configuredMax = this._options.maxFileNameLength
      ? Math.floor(this._options.maxFileNameLength)
      : platformDefault

    let effectiveMax = configuredMax
    if (process.platform === 'win32') {
      const absoluteOutputDir = path.resolve(
        this._options.outputDir || 'videos',
      )
      const remainingPathBudget =
        WINDOWS_MAX_PATH_LENGTH - absoluteOutputDir.length - 1
      if (remainingPathBudget > 0) {
        effectiveMax = Math.min(effectiveMax, remainingPathBudget)
      }
    }

    return Math.max(MIN_SAFE_FILENAME_LENGTH, effectiveMax)
  }

  private _sanitizeFileToken(
    value: string | undefined,
    maxLength: number,
  ): string {
    return sanitizeFileToken(value, maxLength)
  }

  private _normalizeOutputDir(outputDir: string | undefined): string {
    const trimmed = outputDir?.trim()
    if (!trimmed) {
      return 'videos'
    }
    return trimmed
  }

  private _normalizePositiveInt(
    value: number | undefined,
    fallback: number,
  ): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return fallback
    }
    return Math.floor(value)
  }

  private _normalizeFileNameOverflowStrategy(
    strategy: WdioPuppeteerVideoServiceFileNameOverflowStrategy | undefined,
  ): WdioPuppeteerVideoServiceFileNameOverflowStrategy {
    if (strategy === 'session') {
      return 'session'
    }
    return 'truncate'
  }

  private _normalizeFileNameStyle(
    style: WdioPuppeteerVideoServiceFileNameStyle | undefined,
  ): WdioPuppeteerVideoServiceFileNameStyle {
    if (style === 'session') {
      return 'session'
    }
    if (style === 'sessionFull') {
      return 'sessionFull'
    }
    return 'test'
  }

  private _normalizeMp4Mode(
    mode: WdioPuppeteerVideoServiceMp4Mode | undefined,
  ): WdioPuppeteerVideoServiceMp4Mode {
    if (mode === 'direct') {
      return 'direct'
    }
    if (mode === 'transcode') {
      return 'transcode'
    }
    return 'auto'
  }

  private _normalizePerformanceProfile(
    profile: WdioPuppeteerVideoServicePerformanceProfile | undefined,
  ): WdioPuppeteerVideoServicePerformanceProfile {
    if (profile === 'parallel') {
      return 'parallel'
    }
    return 'default'
  }

  private _isBenignStreamWriteError(error: NodeJS.ErrnoException): boolean {
    if (error.code === 'EPIPE') {
      return true
    }

    const message = error.message.toLowerCase()
    return (
      message.includes('cannot call write after a stream was destroyed') ||
      message.includes('write after end')
    )
  }

  private _describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message
    }
    if (typeof error === 'string') {
      return error
    }
    return String(error)
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
