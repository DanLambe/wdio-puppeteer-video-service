import type {
  AllureIntegrationOptions,
  ArtifactNameStyle,
  ConcurrencyOptions,
  InternalArtifactNameStyle,
  InternalPostProcessMode,
  InternalRecordingStartMode,
  LogLevel,
  ProcessingMergeOptions,
  ProcessingOptions,
  RecordingOptions,
  ResolvedWdioPuppeteerVideoServiceOptions,
  ServiceProfile,
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
  const allure = options.integrations?.allure
  const profile = options.profile ?? 'default'
  const retain = recording.retain ?? 'failures'
  const platformMaxFilenameLength = resolvePlatformMaxFilenameLength(platform)

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
  const resolvedAllure = resolveAllureOptions(allure)

  const resolvedOptions: ResolvedWdioPuppeteerVideoServiceOptions = {
    outputDir: normalization.normalizeOutputDir(options.outputDir),
    recordingRetain: retain,
    captureViewport: capture.viewport ?? 'current',
    fps: capture.fps ?? resolveProfileFps(profile),
    captureQuality: capture.quality ?? 30,
    captureScale: capture.scale ?? 1,
    captureSpeed: capture.speed ?? 1,
    framePriming: capture.framePriming ?? profile !== 'ci',
    puppeteerConnectionTimeoutMs:
      capture.connectionTimeoutMs ?? DEFAULT_PUPPETEER_CONNECTION_TIMEOUT_MS,
    recordOnRetries: recording.attempts === 'retries',
    specLevelRecording: recording.scope === 'spec',
    segmentOnWindowSwitch: resolveWindowSegmentation(recording, profile),
    maxConcurrentRecordings: concurrency.maxRecordingsPerProcess ?? 0,
    maxGlobalRecordings: concurrency.maxRecordingsGlobal ?? 0,
    recordingStartMode: resolveRecordingStartMode(
      concurrency.startMode,
      profile === 'ci' ? 'fast-fail' : 'blocking',
    ),
    recordingStartTimeoutMs:
      concurrency.startTimeoutMs ?? DEFAULT_RECORDING_START_TIMEOUT_MS,
    maxConcurrentPostProcesses: concurrency.maxPostProcessesPerProcess ?? 0,
    maxGlobalPostProcesses:
      concurrency.maxPostProcessesGlobal ?? (profile === 'ci' ? 1 : 0),
    postProcessStartMode: resolveRecordingStartMode(
      concurrency.postProcessStartMode,
      'blocking',
    ),
    postProcessStartTimeoutMs:
      concurrency.postProcessStartTimeoutMs ??
      DEFAULT_RECORDING_START_TIMEOUT_MS,
    postProcessMode: resolvePostProcessMode(processing, profile),
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
    ...(resolvedAllure ? { allure: resolvedAllure } : {}),
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

const resolvePlatformMaxFilenameLength = (
  platform: NodeJS.Platform,
): number => {
  return platform === 'win32'
    ? WINDOWS_DEFAULT_MAX_FILENAME_LENGTH
    : DEFAULT_MAX_FILENAME_LENGTH
}

const resolveProfileFps = (profile: ServiceProfile): number => {
  return profile === 'default' ? 30 : 24
}

const resolveWindowSegmentation = (
  recording: RecordingOptions,
  profile: ServiceProfile,
): boolean => {
  if (recording.windowChanges === undefined) {
    return profile !== 'ci'
  }
  return recording.windowChanges === 'segment'
}

const resolveRecordingStartMode = (
  configuredMode: ConcurrencyOptions['startMode'],
  defaultMode: NonNullable<ConcurrencyOptions['startMode']>,
): InternalRecordingStartMode => {
  return (configuredMode ?? defaultMode) === 'fast-fail'
    ? 'fastFail'
    : 'blocking'
}

const resolvePostProcessMode = (
  processing: ProcessingOptions,
  profile: ServiceProfile,
): InternalPostProcessMode => {
  const defaultTiming = profile === 'ci' ? 'after-worker' : 'after-test'
  return (processing.timing ?? defaultTiming) === 'after-worker'
    ? 'deferred'
    : 'immediate'
}

const resolveAllureOptions = (
  allure: AllureIntegrationOptions | undefined,
): ResolvedWdioPuppeteerVideoServiceOptions['allure'] => {
  if (!allure) {
    return undefined
  }
  return {
    attach: allure.attach ?? 'failures',
    ...(allure.maxBytes === undefined ? {} : { maxBytes: allure.maxBytes }),
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
