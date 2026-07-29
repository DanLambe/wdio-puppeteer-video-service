import type {
  OutputFormat,
  ResolvedWdioPuppeteerVideoServiceOptions,
} from '../types.js'
import type { ProcessBoundary } from './boundaries.js'
import {
  getFfmpegCandidates,
  probeDirectMp4Support,
  readFfmpegVersion,
  resolveAvailableFfmpegPath,
} from './ffmpeg.js'
import type {
  FfmpegProcessRegistry,
  RunFfmpegOptions,
} from './ffmpeg-runner.js'
import type { ServiceLogger } from './logging.js'
import type { PostProcessSlotScheduler } from './recording-slots.js'

export type FfmpegRunner = (
  options: RunFfmpegOptions,
  processRegistry: FfmpegProcessRegistry,
) => Promise<boolean>

type FfmpegRuntimeOptions = Pick<
  ResolvedWdioPuppeteerVideoServiceOptions,
  'concurrency' | 'processing'
>

export interface FfmpegRuntimeDependencies {
  readonly options: FfmpegRuntimeOptions
  readonly process: ProcessBoundary
  readonly processRegistry: FfmpegProcessRegistry
  readonly createPostProcessSlotScheduler: () => PostProcessSlotScheduler
  readonly runFfmpeg: FfmpegRunner
  readonly log: ServiceLogger
  readonly onVersion?: (version: string) => Promise<void> | void
  readonly getCandidates?: typeof getFfmpegCandidates
  readonly resolveAvailablePath?: typeof resolveAvailableFfmpegPath
  readonly readVersion?: typeof readFfmpegVersion
  readonly probeDirectMp4?: typeof probeDirectMp4Support
}

export class FfmpegRuntime {
  private readonly options: FfmpegRuntimeOptions
  private readonly process: ProcessBoundary
  private readonly processRegistry: FfmpegProcessRegistry
  private readonly activePostProcessSlotSchedulers =
    new Set<PostProcessSlotScheduler>()
  private readonly createPostProcessSlotScheduler: () => PostProcessSlotScheduler
  private readonly runFfmpegProcess: FfmpegRunner
  private readonly log: ServiceLogger
  private readonly onVersion:
    | ((version: string) => Promise<void> | void)
    | undefined
  private readonly getCandidates: typeof getFfmpegCandidates
  private readonly resolveAvailablePath: typeof resolveAvailableFfmpegPath
  private readonly readVersion: typeof readFfmpegVersion
  private readonly probeDirectMp4: typeof probeDirectMp4Support
  private available = false
  private resolvedPath: string | undefined
  private candidates: string[] = []
  private initializationTask: Promise<boolean> | undefined
  private initializationCompleted = false
  private warnedAboutMp4AutoFallback = false
  private warnedAboutMissingFfmpeg = false
  private forceMp4Transcode = false
  private acceptingWork = true

  constructor(dependencies: FfmpegRuntimeDependencies) {
    this.options = dependencies.options
    this.process = dependencies.process
    this.processRegistry = dependencies.processRegistry
    this.createPostProcessSlotScheduler =
      dependencies.createPostProcessSlotScheduler
    this.runFfmpegProcess = dependencies.runFfmpeg
    this.log = dependencies.log
    this.onVersion = dependencies.onVersion
    this.getCandidates = dependencies.getCandidates ?? getFfmpegCandidates
    this.resolveAvailablePath =
      dependencies.resolveAvailablePath ?? resolveAvailableFfmpegPath
    this.readVersion = dependencies.readVersion ?? readFfmpegVersion
    this.probeDirectMp4 = dependencies.probeDirectMp4 ?? probeDirectMp4Support
  }

  resetForSession(): void {
    this.acceptingWork = true
    this.available = false
    this.resolvedPath = undefined
    this.candidates = []
    this.initializationTask = undefined
    this.initializationCompleted = false
  }

  async ensureReady(): Promise<boolean> {
    if (!this.acceptingWork) {
      return false
    }
    if (this.available) {
      return true
    }
    if (this.initializationCompleted) {
      return false
    }

    this.initializationTask ??= this.initialize().finally(() => {
      this.initializationCompleted = true
      this.initializationTask = undefined
    })
    const initialized = await this.initializationTask
    if (!this.acceptingWork) {
      this.available = false
      this.initializationCompleted = false
      return false
    }
    return initialized
  }

  resolvePath(): string {
    const configuredPath = this.options.processing.ffmpeg.path?.trim()
    const environmentPath = this.process.environment('FFMPEG_PATH')?.trim()
    return this.resolvedPath || configuredPath || environmentPath || 'ffmpeg'
  }

  shouldTranscode(outputFormat: OutputFormat): boolean {
    if (outputFormat !== 'mp4') {
      return false
    }
    if (this.options.processing.transcode.enabled) {
      return true
    }

    const mode = this.options.processing.mp4Mode
    return mode === 'transcode' || (mode === 'auto' && this.forceMp4Transcode)
  }

  async run(args: string[], operation: string): Promise<boolean> {
    if (!this.acceptingWork) {
      return false
    }
    return this.runFfmpegProcess(
      {
        args,
        available: this.available,
        ffmpegPath: this.resolvePath(),
        log: this.log,
        markUnavailable: () => {
          this.available = false
        },
        operation,
        timeoutMs: this.options.processing.ffmpeg.timeoutMs,
        warnMissing: (reason) => {
          this.warnMissingFfmpeg(reason)
        },
      },
      this.processRegistry,
    )
  }

  async withPostProcessSlot<T>(
    operation: string,
    task: () => Promise<T>,
  ): Promise<T | undefined> {
    if (!this.acceptingWork) {
      return undefined
    }
    const slotScheduler = this.createPostProcessSlotScheduler()
    const acquired = await slotScheduler.acquire()
    if (!acquired) {
      const timeout = this.options.concurrency.postProcessStartTimeoutMs
      this.log(
        'warn',
        `[WdioPuppeteerVideoService] Unable to start ${operation} within ${timeout.toString()}ms because post-processing capacity is exhausted.`,
      )
      return undefined
    }
    this.activePostProcessSlotSchedulers.add(slotScheduler)

    try {
      if (!this.acceptingWork) {
        return undefined
      }
      return await task()
    } finally {
      await this.releasePostProcessSlot(slotScheduler)
    }
  }

  async terminateAll(): Promise<void> {
    this.acceptingWork = false
    await this.processRegistry.terminateAll()
  }

  resumeAfterTeardown(): void {
    this.acceptingWork = true
  }

  async releaseHeldPostProcessSlots(): Promise<void> {
    await Promise.all(
      [...this.activePostProcessSlotSchedulers].map(async (slotScheduler) => {
        await this.releasePostProcessSlot(slotScheduler)
      }),
    )
  }

  private async releasePostProcessSlot(
    slotScheduler: PostProcessSlotScheduler,
  ): Promise<void> {
    if (!this.activePostProcessSlotSchedulers.delete(slotScheduler)) {
      return
    }
    await slotScheduler.release()
  }

  private async initialize(): Promise<boolean> {
    this.candidates = this.getCandidates(
      this.options.processing.ffmpeg.path?.trim(),
      this.process.environment('FFMPEG_PATH')?.trim(),
    )
    this.resolvedPath = await this.resolveAvailablePath(this.candidates)
    this.available = !!this.resolvedPath
    const executablePath = this.resolvedPath
    if (!this.available || !executablePath) {
      this.warnMissingFfmpeg('Video recording is disabled for this worker.')
      return false
    }

    this.log(
      'info',
      `[WdioPuppeteerVideoService] Using ffmpeg binary: ${executablePath}`,
    )
    const version = await this.readVersion(executablePath)
    if (version) {
      await this.onVersion?.(version)
    }
    await this.configureMp4RecordingMode(executablePath)
    return true
  }

  private async configureMp4RecordingMode(
    executablePath: string,
  ): Promise<void> {
    this.forceMp4Transcode = false
    const processing = this.options.processing
    if (processing.format !== 'mp4' || processing.transcode.enabled) {
      return
    }

    const mode = processing.mp4Mode
    if (mode === 'transcode') {
      this.forceMp4Transcode = true
      this.log(
        'info',
        '[WdioPuppeteerVideoService] MP4 strategy is set to transcode mode.',
      )
      return
    }

    const supportsDirectMp4 =
      (await this.withPostProcessSlot('direct MP4 capability probe', () =>
        this.probeDirectMp4(executablePath, {
          onProbeFailure: (details) => {
            this.log(
              'debug',
              `[WdioPuppeteerVideoService] Direct MP4 probe failed: ${details}`,
            )
          },
        }),
      )) ?? false
    if (supportsDirectMp4) {
      this.log(
        'info',
        '[WdioPuppeteerVideoService] Detected ffmpeg support for direct MP4 recording.',
      )
      return
    }

    if (mode === 'direct') {
      this.log(
        'warn',
        "[WdioPuppeteerVideoService] MP4 strategy is `direct`, but detected ffmpeg may not support Puppeteer direct MP4 mode. Consider using `processing.mp4Mode: 'transcode'` or `processing.mp4Mode: 'auto'`.",
      )
      return
    }

    this.forceMp4Transcode = true
    if (this.warnedAboutMp4AutoFallback) {
      return
    }
    this.warnedAboutMp4AutoFallback = true
    this.log(
      'warn',
      "[WdioPuppeteerVideoService] Direct MP4 compatibility probe failed. Falling back to MP4 transcode mode (`processing.mp4Mode: 'auto'`).",
    )
  }

  private warnMissingFfmpeg(reason: string): void {
    if (this.warnedAboutMissingFfmpeg) {
      return
    }
    this.warnedAboutMissingFfmpeg = true
    const configuredPath = this.options.processing.ffmpeg.path
      ? `Configured processing.ffmpeg.path: ${this.options.processing.ffmpeg.path}.`
      : 'No processing.ffmpeg.path was provided.'
    const candidateList =
      this.candidates.length > 0
        ? ` Checked candidates: ${this.candidates.join(', ')}.`
        : ''
    this.log(
      'warn',
      `[WdioPuppeteerVideoService] FFmpeg is required but unavailable. ${configuredPath}${candidateList} Install FFmpeg and make it available on PATH, set \`processing.ffmpeg.path\`, or install \`ffmpeg-static\` in your project. ${reason}`,
    )
  }
}
