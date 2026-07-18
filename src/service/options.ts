import type {
  ArtifactNameStyle,
  InternalArtifactNameStyle,
  LogLevel,
  ProcessingMergeOptions,
  ResolvedWdioPuppeteerVideoServiceOptions,
  WdioPuppeteerVideoServiceOptions,
} from '../types.js'
import {
  DEFAULT_MAX_FILENAME_LENGTH,
  DEFAULT_PUPPETEER_CONNECTION_TIMEOUT_MS,
  DEFAULT_RECORDING_START_TIMEOUT_MS,
  WINDOWS_DEFAULT_MAX_FILENAME_LENGTH,
} from './constants.js'
import { normalizeLogLevel } from './logging.js'
import * as normalization from './normalization.js'
import { validateServiceOptions } from './option-validation.js'

export interface ResolvedServiceConfiguration {
  hasExplicitLogLevel: boolean
  logLevel: LogLevel
  maxSlugLength: number
  options: ResolvedWdioPuppeteerVideoServiceOptions
}

export const resolveServiceConfiguration = (
  options: WdioPuppeteerVideoServiceOptions = {},
  platform: NodeJS.Platform = process.platform,
): ResolvedServiceConfiguration => {
  validateServiceOptions(options)

  const recording = options.recording ?? {}
  const filters = recording.filters ?? {}
  const capture = options.capture ?? {}
  const processing = options.processing ?? {}
  const concurrency = options.concurrency ?? {}
  const naming = options.artifacts?.naming ?? {}
  const profile = options.profile ?? 'default'
  const retain = recording.retain ?? 'failures'
  const platformMaxFilenameLength =
    platform === 'win32'
      ? WINDOWS_DEFAULT_MAX_FILENAME_LENGTH
      : DEFAULT_MAX_FILENAME_LENGTH

  const ciPinnedWarnLogLevel =
    profile === 'ci' && options.logLevel === undefined
  const hasExplicitLogLevel =
    typeof options.logLevel === 'string' || ciPinnedWarnLogLevel
  const logLevel = ciPinnedWarnLogLevel
    ? 'warn'
    : normalizeLogLevel(options.logLevel)

  const transcode = normalization.normalizeTranscodeOptions(
    processing.transcode,
  )
  const mergeSegments = resolveMergeOptions(
    processing.merge,
    profile !== 'default',
  )
  const globalRecordingLockDir = normalization.normalizeOptionalDir(
    concurrency.lockDir,
  )
  const ffmpegPath = normalization.normalizeOptionalDir(processing.ffmpeg?.path)

  const resolvedOptions: ResolvedWdioPuppeteerVideoServiceOptions = {
    outputDir: normalization.normalizeOutputDir(options.outputDir),
    recordingRetain: retain,
    captureViewport: capture.viewport ?? 'current',
    fps: capture.fps ?? (profile === 'default' ? 30 : 24),
    captureQuality: capture.quality ?? 30,
    captureScale: capture.scale ?? 1,
    captureSpeed: capture.speed ?? 1,
    framePriming:
      capture.framePriming === undefined
        ? profile !== 'ci'
        : capture.framePriming,
    puppeteerConnectionTimeoutMs:
      capture.connectionTimeoutMs ?? DEFAULT_PUPPETEER_CONNECTION_TIMEOUT_MS,
    recordOnRetries: recording.attempts === 'retries',
    specLevelRecording: recording.scope === 'spec',
    segmentOnWindowSwitch:
      recording.windowChanges === undefined
        ? profile !== 'ci'
        : recording.windowChanges === 'segment',
    maxConcurrentRecordings: concurrency.maxRecordingsPerProcess ?? 0,
    maxGlobalRecordings: concurrency.maxRecordingsGlobal ?? 0,
    recordingStartMode:
      (concurrency.startMode ??
        (profile === 'ci' ? 'fast-fail' : 'blocking')) === 'fast-fail'
        ? 'fastFail'
        : 'blocking',
    recordingStartTimeoutMs:
      concurrency.startTimeoutMs ?? DEFAULT_RECORDING_START_TIMEOUT_MS,
    postProcessMode:
      (processing.timing ??
        (profile === 'ci' ? 'after-worker' : 'after-test')) === 'after-worker'
        ? 'deferred'
        : 'immediate',
    includeSpecPatterns: normalization.normalizePatternList(
      filters.includeSpecs,
    ),
    excludeSpecPatterns: normalization.normalizePatternList(
      filters.excludeSpecs,
    ),
    includeTagPatterns: normalization.normalizePatternList(filters.includeTags),
    excludeTagPatterns: normalization.normalizePatternList(filters.excludeTags),
    performanceProfile: profile,
    failurePolicy: options.failurePolicy ?? 'warn',
    maxFileNameLength: naming.maxLength ?? platformMaxFilenameLength,
    fileNameOverflowStrategy: naming.overflow ?? 'truncate',
    fileNameStyle: toInternalNameStyle(naming.style ?? 'test'),
    ffmpegTimeoutMs: processing.ffmpeg?.timeoutMs ?? 0,
    outputFormat: processing.format ?? 'webm',
    mp4Mode: processing.mp4Mode ?? 'auto',
    transcode,
    mergeSegments,
    ...(capture.crop ? { captureCrop: capture.crop } : {}),
    ...(globalRecordingLockDir ? { globalRecordingLockDir } : {}),
    ...(ffmpegPath ? { ffmpegPath } : {}),
  }

  return {
    hasExplicitLogLevel,
    logLevel,
    maxSlugLength: normalization.computeMaxSlugLength(
      resolvedOptions,
      platform,
    ),
    options: resolvedOptions,
  }
}

const resolveMergeOptions = (
  options: ProcessingMergeOptions | undefined,
  disableByProfile: boolean,
): ProcessingMergeOptions => {
  const normalized = normalization.normalizeMergeOptions(options)
  if (disableByProfile && options?.enabled === undefined) {
    return { ...normalized, enabled: false }
  }
  return normalized
}

const toInternalNameStyle = (
  style: ArtifactNameStyle,
): InternalArtifactNameStyle => {
  if (style === 'test-full') {
    return 'testFull'
  }
  if (style === 'session-full') {
    return 'sessionFull'
  }
  return style
}
