import type {
  AllureIntegrationOptions,
  LogLevel,
  ProcessingMergeOptions,
  ProcessingOptions,
  RecordingOptions,
  ResolvedAllureIntegrationOptions,
  ResolvedProcessingMergeOptions,
  ResolvedProcessingTranscodeOptions,
  ResolvedWdioPuppeteerVideoServiceOptions,
  ServiceProfile,
  WdioPuppeteerVideoServiceOptions,
} from '../types.js'
import {
  CI_TRANSCODE_FFMPEG_ARGS,
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
  const transcodeFfmpegArgs =
    transcode.ffmpegArgs ??
    (profile === 'ci' ? [...CI_TRANSCODE_FFMPEG_ARGS] : undefined)

  const resolvedOptions = freezeResolvedOptions({
    outputDir: normalization.normalizeOutputDir(options.outputDir),
    recording: {
      scope: recording.scope ?? 'test',
      attempts: recording.attempts ?? 'all',
      retain,
      windowChanges: resolveWindowChanges(recording, profile),
      filters: {
        includeSpecs: normalization.normalizePatternList(filters.includeSpecs),
        excludeSpecs: normalization.normalizePatternList(filters.excludeSpecs),
        includeTags: normalization.normalizePatternList(filters.includeTags),
        excludeTags: normalization.normalizePatternList(filters.excludeTags),
      },
    },
    capture: {
      viewport: capture.viewport ?? 'current',
      fps: capture.fps ?? resolveProfileFps(profile),
      quality: capture.quality ?? 30,
      scale: capture.scale ?? 1,
      speed: capture.speed ?? 1,
      framePriming: capture.framePriming ?? profile !== 'ci',
      connectionTimeoutMs:
        capture.connectionTimeoutMs ?? DEFAULT_PUPPETEER_CONNECTION_TIMEOUT_MS,
      ...(capture.crop ? { crop: capture.crop } : {}),
    },
    processing: {
      format: processing.format ?? 'webm',
      mp4Mode: processing.mp4Mode ?? 'auto',
      timing: resolveProcessingTiming(processing, profile),
      ffmpeg: {
        timeoutMs: processing.ffmpeg?.timeoutMs ?? 0,
        ...(ffmpegPath ? { path: ffmpegPath } : {}),
      },
      transcode: {
        enabled: transcode.enabled ?? false,
        deleteOriginal: transcode.deleteOriginal ?? true,
        ...(transcodeFfmpegArgs === undefined
          ? {}
          : { ffmpegArgs: transcodeFfmpegArgs }),
      },
      merge: mergeSegments,
    },
    concurrency: {
      maxRecordingsPerProcess: concurrency.maxRecordingsPerProcess ?? 0,
      maxRecordingsGlobal: concurrency.maxRecordingsGlobal ?? 0,
      startMode:
        concurrency.startMode ?? (profile === 'ci' ? 'fast-fail' : 'blocking'),
      startTimeoutMs:
        concurrency.startTimeoutMs ?? DEFAULT_RECORDING_START_TIMEOUT_MS,
      maxPostProcessesPerProcess: concurrency.maxPostProcessesPerProcess ?? 1,
      maxPostProcessesGlobal:
        concurrency.maxPostProcessesGlobal ?? (profile === 'ci' ? 1 : 0),
      postProcessStartMode: concurrency.postProcessStartMode ?? 'blocking',
      postProcessStartTimeoutMs:
        concurrency.postProcessStartTimeoutMs ??
        DEFAULT_RECORDING_START_TIMEOUT_MS,
      ...(globalRecordingLockDir ? { lockDir: globalRecordingLockDir } : {}),
    },
    artifacts: {
      naming: {
        style: naming.style ?? 'test',
        maxLength: naming.maxLength ?? platformMaxFilenameLength,
        overflow: naming.overflow ?? 'truncate',
      },
    },
    integrations: {
      ...(resolvedAllure ? { allure: resolvedAllure } : {}),
    },
    profile,
    logLevel,
    failurePolicy: options.failurePolicy ?? 'warn',
  })

  return {
    hasExplicitLogLevel,
    logLevel,
    maxSlugLength: normalization.computeMaxSlugLength(
      {
        maxFileNameLength: resolvedOptions.artifacts.naming.maxLength,
        outputDir: resolvedOptions.outputDir,
      },
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

const resolveWindowChanges = (
  recording: RecordingOptions,
  profile: ServiceProfile,
): 'ignore' | 'segment' => {
  if (recording.windowChanges === undefined) {
    return profile === 'ci' ? 'ignore' : 'segment'
  }
  return recording.windowChanges
}

const resolveProcessingTiming = (
  processing: ProcessingOptions,
  profile: ServiceProfile,
): 'after-test' | 'after-worker' => {
  const defaultTiming = profile === 'ci' ? 'after-worker' : 'after-test'
  return processing.timing ?? defaultTiming
}

const resolveAllureOptions = (
  allure: AllureIntegrationOptions | undefined,
): ResolvedAllureIntegrationOptions | undefined => {
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
): ResolvedProcessingMergeOptions => {
  const normalized = normalization.normalizeMergeOptions(options)
  return {
    enabled:
      disableByProfile && options?.enabled === undefined
        ? false
        : (normalized.enabled ?? false),
    deleteSegments: normalized.deleteSegments ?? true,
  }
}

const freezeResolvedOptions = (
  options: ResolvedWdioPuppeteerVideoServiceOptions,
): ResolvedWdioPuppeteerVideoServiceOptions => {
  const freezeList = (values: readonly string[]): readonly string[] =>
    Object.freeze([...values])
  const recordingFilters = Object.freeze({
    includeSpecs: freezeList(options.recording.filters.includeSpecs),
    excludeSpecs: freezeList(options.recording.filters.excludeSpecs),
    includeTags: freezeList(options.recording.filters.includeTags),
    excludeTags: freezeList(options.recording.filters.excludeTags),
  })
  const transcode = Object.freeze({
    ...options.processing.transcode,
    ...(options.processing.transcode.ffmpegArgs === undefined
      ? {}
      : { ffmpegArgs: freezeList(options.processing.transcode.ffmpegArgs) }),
  }) satisfies ResolvedProcessingTranscodeOptions

  return Object.freeze({
    ...options,
    recording: Object.freeze({
      ...options.recording,
      filters: recordingFilters,
    }),
    capture: Object.freeze({
      ...options.capture,
      viewport:
        options.capture.viewport === 'current'
          ? 'current'
          : Object.freeze({ ...options.capture.viewport }),
      ...(options.capture.crop
        ? { crop: Object.freeze({ ...options.capture.crop }) }
        : {}),
    }),
    processing: Object.freeze({
      ...options.processing,
      ffmpeg: Object.freeze({ ...options.processing.ffmpeg }),
      transcode,
      merge: Object.freeze({ ...options.processing.merge }),
    }),
    concurrency: Object.freeze({ ...options.concurrency }),
    artifacts: Object.freeze({
      naming: Object.freeze({ ...options.artifacts.naming }),
    }),
    integrations: Object.freeze({
      ...(options.integrations.allure
        ? { allure: Object.freeze({ ...options.integrations.allure }) }
        : {}),
    }),
  })
}
