import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  WdioPuppeteerVideoServiceLogLevel,
  WdioPuppeteerVideoServiceMergeOptions,
  WdioPuppeteerVideoServiceOptions,
  WdioPuppeteerVideoServiceTranscodeOptions,
} from './types.js'

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
const require = createRequire(import.meta.url)
const LOG_LEVEL_PRIORITY: Record<WdioPuppeteerVideoServiceLogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
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
  private _recordedSegments = new Set<string>()
  private _isChromium = false
  private _currentWindowHandle: string | undefined
  private _sessionIdToken = ''
  private _logLevel: WdioPuppeteerVideoServiceLogLevel = 'warn'
  private readonly _hasExplicitLogLevel: boolean
  private _ffmpegAvailable = false
  private _resolvedFfmpegPath: string | undefined
  private _ffmpegCandidates: string[] = []
  private _recordingTask: Promise<void> = Promise.resolve()
  private _warnedAboutMp4Compatibility = false
  private _warnedAboutMissingFfmpeg = false

  constructor(options: WdioPuppeteerVideoServiceOptions) {
    this._hasExplicitLogLevel = typeof options.logLevel === 'string'
    this._logLevel = this._normalizeLogLevel(options.logLevel)

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

    if (options.ffmpegArgs && !mergedTranscode.ffmpegArgs) {
      mergedTranscode.ffmpegArgs = options.ffmpegArgs
    }

    if (options.ffmpegArgs) {
      this._log(
        'warn',
        '[WdioPuppeteerVideoService] `ffmpegArgs` is deprecated. Use `transcode.ffmpegArgs` instead.',
      )
    }

    const mergedOptions: WdioPuppeteerVideoServiceOptions = {
      outputDir: 'videos',
      saveAllVideos: false,
      videoWidth: 1280,
      videoHeight: 720,
      fps: 30,
      outputFormat: 'webm',
      fileNameOverflowStrategy: 'truncate',
      maxFileNameLength:
        process.platform === 'win32'
          ? WINDOWS_DEFAULT_MAX_FILENAME_LENGTH
          : DEFAULT_MAX_FILENAME_LENGTH,
      ...options,
      transcode: mergedTranscode,
      mergeSegments: mergedMergeSegments,
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
    }
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
    if (!this._ffmpegAvailable) {
      this._warnMissingFfmpeg('Video recording is disabled for this worker.')
    } else {
      this._log(
        'info',
        `[WdioPuppeteerVideoService] Using ffmpeg binary: ${this._resolvedFfmpegPath}`,
      )
    }

    await fs.mkdir(this._options.outputDir ?? 'videos', { recursive: true })
  }

  async beforeTest(test: Frameworks.Test): Promise<void> {
    if (!this._isChromium || !this._browser || !this._ffmpegAvailable) {
      return
    }

    await this._runSerializedRecordingTask(async () => {
      this._log(
        'debug',
        `[WdioPuppeteerVideoService] Starting test recording: ${test.fullTitle || test.title}`,
      )
      this._currentTestSlug = this._buildTestSlug(test)
      this._currentSegment = 1
      this._recordedSegments.clear()
      this._currentWindowHandle = undefined
      this._activeSegment = undefined

      await this._startRecording()
    })
  }

  async afterTest(
    _test: Frameworks.Test,
    _context: unknown,
    result: Frameworks.TestResult,
  ): Promise<void> {
    if (!this._isChromium || !this._ffmpegAvailable) {
      return
    }

    await this._runSerializedRecordingTask(async () => {
      await this._stopRecording()

      const shouldKeepArtifacts =
        !result.passed || !!this._options.saveAllVideos
      this._log(
        'debug',
        `[WdioPuppeteerVideoService] Finished test recording (passed=${result.passed}, keepArtifacts=${shouldKeepArtifacts}).`,
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
    })
  }

  async after(): Promise<void> {
    if (!this._isChromium || !this._ffmpegAvailable) {
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
          .catch(() => undefined)
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
        .catch(() => undefined)

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
        .catch(() => undefined)

      const targetId = `wdio-video-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      await this._browser.execute((id: string) => {
        const win = window as unknown as { _wdio_video_id?: string }
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

      await page.bringToFront().catch(() => {})
      const outputFormat: OutputFormat = this._options.outputFormat ?? 'webm'
      const transcodeEnabled =
        outputFormat === 'mp4' && (this._options.transcode?.enabled ?? false)

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
      }

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
    const mergedFormat =
      extension === '.mp4' ? 'mp4' : extension === '.webm' ? 'webm' : undefined

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
      await fs.unlink(mergedPath).catch(() => {})

      if (deleteSegments) {
        await fs.rename(segmentPaths[0], mergedPath).catch(async () => {
          await fs.copyFile(segmentPaths[0], mergedPath)
          await fs.unlink(segmentPaths[0]).catch(() => {})
        })
        this._recordedSegments.clear()
      } else {
        await fs.copyFile(segmentPaths[0], mergedPath)
      }

      this._recordedSegments.add(mergedPath)
      return
    }

    const concatListPath = path.join(
      this._options.outputDir || 'videos',
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

    await fs.unlink(mergedPath).catch(() => {})

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

    await fs.unlink(concatListPath).catch(() => {})

    if (!merged) {
      return
    }

    this._recordedSegments.add(mergedPath)

    if (!deleteSegments) {
      return
    }

    for (const filePath of segmentPaths) {
      await fs.unlink(filePath).catch(() => {})
      this._recordedSegments.delete(filePath)
    }
  }

  private _getSegmentPath(format?: OutputFormat): string {
    const resolvedFormat = format ?? this._options.outputFormat ?? 'webm'
    const fileStem = this._currentTestSlug || 'test'
    const filename = `${fileStem}_part${this._currentSegment}.${resolvedFormat}`
    return path.join(this._options.outputDir || 'videos', filename)
  }

  private _getMergedOutputPath(format?: OutputFormat): string {
    const resolvedFormat = format ?? this._options.outputFormat ?? 'webm'
    const fileStem = this._currentTestSlug || 'test'
    const filename = `${fileStem}.${resolvedFormat}`
    return path.join(this._options.outputDir || 'videos', filename)
  }

  private _extractPartNumber(filePath: string): number {
    const partMatch = path.basename(filePath).match(/_part(\d+)\./)
    if (!partMatch) {
      return Number.MAX_SAFE_INTEGER
    }

    return Number.parseInt(partMatch[1], 10)
  }

  private _buildConcatList(segmentPaths: string[]): string {
    return segmentPaths
      .map((filePath) => {
        const normalizedPath = path.resolve(filePath).replace(/\\/g, '/')
        const escapedPath = normalizedPath.replace(/'/g, "'\\''")
        return `file '${escapedPath}'`
      })
      .join('\n')
  }

  private _resolveFfmpegPath(): string {
    const configuredPath = this._options.ffmpegPath?.trim()
    const envPath = process.env.FFMPEG_PATH?.trim()
    return this._resolvedFfmpegPath || configuredPath || envPath || 'ffmpeg'
  }

  private async _findActivePage(
    puppeteerBrowser: PuppeteerBrowser,
    targetId: string,
  ): Promise<Page | undefined> {
    const startedAt = Date.now()

    while (Date.now() - startedAt < ACTIVE_PAGE_TIMEOUT_MS) {
      const pages = await puppeteerBrowser.pages().catch(() => [])
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
      .catch(() => {})
    await delay(50)
    await page
      .setViewport({ width: targetWidth, height: targetHeight })
      .catch(() => {})
  }

  private async _waitForWriteStream(segment: ActiveSegment): Promise<boolean> {
    const ok = await Promise.race([
      segment.writeStreamDone.then(() => true).catch(() => false),
      delay(WRITE_STREAM_TIMEOUT_MS).then(() => false),
    ])

    if (!ok) {
      segment.writeStream.destroy(
        new Error('Timed out waiting for recording stream to finish'),
      )
      await segment.writeStreamDone.catch(() => {})
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
      await fs.unlink(segment.recordingPath).catch(() => {})
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
        await fs.unlink(segment.recordingPath).catch(() => {})
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

    return await new Promise<boolean>((resolve) => {
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
    return await new Promise<boolean>((resolve) => {
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
          const win = window as unknown as { _wdio_video_id?: string }
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
    if (normalized === 'trace') {
      return 'trace'
    }
    if (normalized === 'debug') {
      return 'debug'
    }
    if (normalized === 'info') {
      return 'info'
    }
    if (normalized === 'warn') {
      return 'warn'
    }
    if (normalized === 'error') {
      return 'error'
    }
    if (normalized === 'silent') {
      return 'silent'
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
    if (level === 'error') {
      if (details === undefined) {
        console.error(formattedMessage)
        return
      }
      console.error(formattedMessage, details)
      return
    }

    if (level === 'warn') {
      if (details === undefined) {
        console.warn(formattedMessage)
        return
      }
      console.warn(formattedMessage, details)
      return
    }

    if (level === 'info') {
      if (details === undefined) {
        console.info(formattedMessage)
        return
      }
      console.info(formattedMessage, details)
      return
    }

    if (details === undefined) {
      console.debug(formattedMessage)
      return
    }
    console.debug(formattedMessage, details)
  }

  private _resetTestState(): void {
    this._recorder = undefined
    this._activeSegment = undefined
    this._currentSegment = 0
    this._currentTestSlug = ''
    this._currentWindowHandle = undefined
    this._recordedSegments.clear()
  }

  private _buildTestSlug(test: Frameworks.Test): string {
    const retry =
      typeof test._currentRetry === 'number' && test._currentRetry > 0
        ? `_retry${test._currentRetry}`
        : ''
    const fileName = test.file ? path.parse(test.file).name : 'spec'
    const hashInput = `${test.file ?? ''}|${test.fullTitle ?? ''}|${test.title}|${test._currentRetry ?? 0}`
    const shortHash = createHash('sha1')
      .update(hashInput)
      .digest('hex')
      .slice(0, 8)
    const sessionPrefix = this._sessionIdToken ? `${this._sessionIdToken}_` : ''
    const suffixToken = `${sessionPrefix}${shortHash}${retry}`
    const maxSlugLength = this._getMaxSlugLength()

    if (suffixToken.length >= maxSlugLength) {
      return this._buildOverflowSlug(shortHash, retry, maxSlugLength)
    }

    const baseBudget = Math.max(1, maxSlugLength - suffixToken.length - 1)
    const baseCandidate = this._sanitizeFileToken(test.title, baseBudget)
    const fallbackCandidate =
      this._sanitizeFileToken(fileName, Math.min(40, baseBudget)) || 'test'

    if (this._options.fileNameOverflowStrategy === 'session') {
      const preferredBase = baseCandidate || fallbackCandidate
      const preferred = `${preferredBase}_${suffixToken}`
      if (preferred.length <= maxSlugLength) {
        return preferred
      }
      return this._buildOverflowSlug(shortHash, retry, maxSlugLength)
    }

    const selectedBase = baseCandidate || fallbackCandidate
    const slug = `${selectedBase}_${suffixToken}`
    if (slug.length <= maxSlugLength) {
      return slug
    }

    const trimmedBase = this._sanitizeFileToken(selectedBase, baseBudget)
    const trimmedSlug = `${trimmedBase || fallbackCandidate}_${suffixToken}`
    if (trimmedSlug.length <= maxSlugLength) {
      return trimmedSlug
    }

    return this._buildOverflowSlug(shortHash, retry, maxSlugLength)
  }

  private _buildOverflowSlug(
    shortHash: string,
    retryToken: string,
    maxSlugLength: number,
  ): string {
    const sessionToken = this._sessionIdToken || 'session'
    const full = `${sessionToken}_${shortHash}${retryToken}`
    if (full.length <= maxSlugLength) {
      return full
    }

    const compact = `${sessionToken}_${shortHash}`
    if (compact.length <= maxSlugLength) {
      return compact
    }

    const sessionBudget = Math.max(4, maxSlugLength - shortHash.length - 1)
    const compactSession = this._sanitizeFileToken(sessionToken, sessionBudget)
    const compactSlug = `${compactSession}_${shortHash}`
    if (compactSlug.length <= maxSlugLength) {
      return compactSlug
    }

    return shortHash.slice(0, Math.max(6, maxSlugLength))
  }

  private _getMaxSlugLength(): number {
    const effectiveMaxFilenameLength = this._getEffectiveMaxFilenameLength()
    return Math.max(16, effectiveMaxFilenameLength - SEGMENT_SUFFIX_MAX_LENGTH)
  }

  private _getEffectiveMaxFilenameLength(): number {
    const configuredMax = this._options.maxFileNameLength
      ? Math.floor(this._options.maxFileNameLength)
      : process.platform === 'win32'
        ? WINDOWS_DEFAULT_MAX_FILENAME_LENGTH
        : DEFAULT_MAX_FILENAME_LENGTH

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
    const normalized = (value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')

    if (normalized.length <= maxLength) {
      return normalized
    }

    return normalized.slice(0, maxLength).replace(/_+$/g, '')
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

  private _buildSessionIdToken(sessionId: string | undefined): string {
    const primaryChunk = sessionId?.split('-')[0]
    const sanitizedPrimary = this._sanitizeFileToken(primaryChunk, 12)
    if (sanitizedPrimary) {
      return sanitizedPrimary.slice(0, 12)
    }

    const sanitized = this._sanitizeFileToken(sessionId, 12)
    return sanitized.slice(0, 12)
  }
}
