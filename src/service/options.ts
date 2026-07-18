import type {
  WdioPuppeteerVideoServiceLogLevel,
  WdioPuppeteerVideoServiceOptions,
} from '../types.js'
import {
  DEFAULT_MAX_FILENAME_LENGTH,
  DEFAULT_RECORDING_START_TIMEOUT_MS,
  WINDOWS_DEFAULT_MAX_FILENAME_LENGTH,
} from './constants.js'
import { normalizeLogLevel } from './logging.js'
import * as normalization from './normalization.js'

export interface ResolvedServiceConfiguration {
  hasExplicitLogLevel: boolean
  logLevel: WdioPuppeteerVideoServiceLogLevel
  maxSlugLength: number
  options: WdioPuppeteerVideoServiceOptions
}

export const resolveServiceConfiguration = (
  options: WdioPuppeteerVideoServiceOptions = {},
  platform: NodeJS.Platform = process.platform,
): ResolvedServiceConfiguration => {
  const performanceProfile = normalization.normalizePerformanceProfile(
    options.performanceProfile,
  )
  const ciPinnedWarnLogLevel =
    performanceProfile === 'ci' && options.logLevel === undefined
  const hasExplicitLogLevel =
    typeof options.logLevel === 'string' || ciPinnedWarnLogLevel
  const logLevel = ciPinnedWarnLogLevel
    ? 'warn'
    : normalizeLogLevel(options.logLevel)

  const mergedTranscode = normalization.normalizeTranscodeOptions(
    options.transcode,
  )
  const mergedMergeSegments = normalization.normalizeMergeOptions(
    options.mergeSegments,
  )
  const platformMaxFilenameLength =
    platform === 'win32'
      ? WINDOWS_DEFAULT_MAX_FILENAME_LENGTH
      : DEFAULT_MAX_FILENAME_LENGTH

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
    maxFileNameLength: platformMaxFilenameLength,
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
      outputFormat: normalization.normalizeOutputFormat(options.outputFormat),
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
      outputFormat: normalization.normalizeOutputFormat(options.outputFormat),
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

  const normalizedGlobalRecordingLockDir = normalization.normalizeOptionalDir(
    mergedOptions.globalRecordingLockDir,
  )
  const resolvedOptions: WdioPuppeteerVideoServiceOptions = {
    ...mergedOptions,
    outputDir: normalization.normalizeOutputDir(mergedOptions.outputDir),
    videoWidth: normalization.normalizePositiveInt(
      mergedOptions.videoWidth,
      1280,
    ),
    videoHeight: normalization.normalizePositiveInt(
      mergedOptions.videoHeight,
      720,
    ),
    fps: normalization.normalizePositiveInt(mergedOptions.fps, 30),
    maxFileNameLength: normalization.normalizePositiveInt(
      mergedOptions.maxFileNameLength,
      platformMaxFilenameLength,
    ),
    fileNameOverflowStrategy: normalization.normalizeFileNameOverflowStrategy(
      mergedOptions.fileNameOverflowStrategy,
    ),
    fileNameStyle: normalization.normalizeFileNameStyle(
      mergedOptions.fileNameStyle,
    ),
    mp4Mode: normalization.normalizeMp4Mode(mergedOptions.mp4Mode),
    outputFormat: normalization.normalizeOutputFormat(
      mergedOptions.outputFormat,
    ),
    performanceProfile,
    recordOnRetries: normalization.normalizeBoolean(
      mergedOptions.recordOnRetries,
    ),
    specLevelRecording: normalization.normalizeBoolean(
      mergedOptions.specLevelRecording,
    ),
    skipViewPortKickoff: normalization.normalizeBoolean(
      mergedOptions.skipViewPortKickoff,
    ),
    segmentOnWindowSwitch: normalization.normalizeBoolean(
      mergedOptions.segmentOnWindowSwitch,
      true,
    ),
    maxConcurrentRecordings: normalization.normalizeNonNegativeInt(
      mergedOptions.maxConcurrentRecordings,
      0,
    ),
    maxGlobalRecordings: normalization.normalizeNonNegativeInt(
      mergedOptions.maxGlobalRecordings,
      0,
    ),
    recordingStartMode: normalization.normalizeRecordingStartMode(
      mergedOptions.recordingStartMode,
    ),
    recordingStartTimeoutMs: normalization.normalizePositiveInt(
      mergedOptions.recordingStartTimeoutMs,
      DEFAULT_RECORDING_START_TIMEOUT_MS,
    ),
    ffmpegTimeoutMs: normalization.normalizeNonNegativeInt(
      mergedOptions.ffmpegTimeoutMs,
      0,
    ),
    ...(normalizedGlobalRecordingLockDir
      ? { globalRecordingLockDir: normalizedGlobalRecordingLockDir }
      : {}),
    transcode: normalization.normalizeTranscodeOptions(mergedOptions.transcode),
    mergeSegments: normalization.normalizeMergeOptions(
      mergedOptions.mergeSegments,
    ),
    postProcessMode: normalization.normalizePostProcessMode(
      mergedOptions.postProcessMode,
    ),
    includeSpecPatterns: normalization.normalizePatternList(
      mergedOptions.includeSpecPatterns,
    ),
    excludeSpecPatterns: normalization.normalizePatternList(
      mergedOptions.excludeSpecPatterns,
    ),
    includeTagPatterns: normalization.normalizePatternList(
      mergedOptions.includeTagPatterns,
    ),
    excludeTagPatterns: normalization.normalizePatternList(
      mergedOptions.excludeTagPatterns,
    ),
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
