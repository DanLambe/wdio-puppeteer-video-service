import path from 'node:path'
import type {
  WdioPuppeteerVideoServiceFileNameOverflowStrategy,
  WdioPuppeteerVideoServiceFileNameStyle,
  WdioPuppeteerVideoServiceMergeOptions,
  WdioPuppeteerVideoServiceMp4Mode,
  WdioPuppeteerVideoServiceOptions,
  WdioPuppeteerVideoServicePerformanceProfile,
  WdioPuppeteerVideoServicePostProcessMode,
  WdioPuppeteerVideoServiceRecordingStartMode,
  WdioPuppeteerVideoServiceTranscodeOptions,
} from '../types.js'
import {
  DEFAULT_MAX_FILENAME_LENGTH,
  MIN_SAFE_FILENAME_LENGTH,
  SEGMENT_SUFFIX_MAX_LENGTH,
  WINDOWS_DEFAULT_MAX_FILENAME_LENGTH,
  WINDOWS_MAX_PATH_LENGTH,
} from './constants.js'

/**
 * Centralized option/input normalization to keep constructor logic predictable.
 */

export const normalizeOutputDir = (outputDir: string | undefined): string => {
  const trimmed = outputDir?.trim()
  if (!trimmed) {
    return 'videos'
  }
  return trimmed
}

export const normalizeOptionalDir = (
  dirPath: string | undefined,
): string | undefined => {
  const trimmed = dirPath?.trim()
  if (!trimmed) {
    return undefined
  }
  return trimmed
}

export const normalizePositiveInt = (
  value: number | undefined,
  fallback: number,
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback
  }
  return Math.floor(value)
}

export const normalizeNonNegativeInt = (
  value: number | undefined,
  fallback: number,
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback
  }

  return Math.floor(value)
}

export const normalizeBoolean = (
  value: boolean | undefined,
  fallback = false,
): boolean => {
  if (typeof value !== 'boolean') {
    return fallback
  }

  return value
}

export const normalizeOutputFormat = (
  format: WdioPuppeteerVideoServiceOptions['outputFormat'] | undefined,
): NonNullable<WdioPuppeteerVideoServiceOptions['outputFormat']> => {
  if (format === 'mp4') {
    return 'mp4'
  }

  return 'webm'
}

export const normalizeTranscodeOptions = (
  options: WdioPuppeteerVideoServiceTranscodeOptions | undefined,
): WdioPuppeteerVideoServiceTranscodeOptions => {
  const optionRecord = toRecord(options)
  const normalizedOptions: WdioPuppeteerVideoServiceTranscodeOptions = {
    deleteOriginal: normalizeBoolean(
      optionRecord?.deleteOriginal as boolean | undefined,
      true,
    ),
  }

  const enabled = optionRecord?.enabled
  if (typeof enabled === 'boolean') {
    normalizedOptions.enabled = enabled
  }

  const ffmpegArgs = normalizeStringList(optionRecord?.ffmpegArgs)
  if (ffmpegArgs !== undefined) {
    normalizedOptions.ffmpegArgs = ffmpegArgs
  }

  return normalizedOptions
}

export const normalizeMergeOptions = (
  options: WdioPuppeteerVideoServiceMergeOptions | undefined,
): WdioPuppeteerVideoServiceMergeOptions => {
  const optionRecord = toRecord(options)
  const normalizedOptions: WdioPuppeteerVideoServiceMergeOptions = {
    deleteSegments: normalizeBoolean(
      optionRecord?.deleteSegments as boolean | undefined,
      true,
    ),
  }

  const enabled = optionRecord?.enabled
  if (typeof enabled === 'boolean') {
    normalizedOptions.enabled = enabled
  }

  return normalizedOptions
}

export const normalizePatternList = (
  patterns: string[] | undefined,
): string[] => {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return []
  }

  const normalizedPatterns: string[] = []
  const seen = new Set<string>()
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') {
      continue
    }
    const trimmedPattern = pattern.trim().toLowerCase()
    if (!trimmedPattern || seen.has(trimmedPattern)) {
      continue
    }
    seen.add(trimmedPattern)
    normalizedPatterns.push(trimmedPattern)
  }

  return normalizedPatterns
}

export const normalizePostProcessMode = (
  mode: WdioPuppeteerVideoServicePostProcessMode | undefined,
): WdioPuppeteerVideoServicePostProcessMode => {
  if (mode === 'deferred') {
    return 'deferred'
  }
  return 'immediate'
}

export const normalizeCandidateValue = (value: string | undefined): string => {
  return (value ?? '').trim().toLowerCase()
}

export const toNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }

  return trimmed
}

export const normalizeFileNameOverflowStrategy = (
  strategy: WdioPuppeteerVideoServiceFileNameOverflowStrategy | undefined,
): WdioPuppeteerVideoServiceFileNameOverflowStrategy => {
  if (strategy === 'session') {
    return 'session'
  }
  return 'truncate'
}

export const normalizeFileNameStyle = (
  style: WdioPuppeteerVideoServiceFileNameStyle | undefined,
): WdioPuppeteerVideoServiceFileNameStyle => {
  if (style === 'testFull') {
    return 'testFull'
  }
  if (style === 'session') {
    return 'session'
  }
  if (style === 'sessionFull') {
    return 'sessionFull'
  }
  return 'test'
}

export const normalizeMp4Mode = (
  mode: WdioPuppeteerVideoServiceMp4Mode | undefined,
): WdioPuppeteerVideoServiceMp4Mode => {
  if (mode === 'direct') {
    return 'direct'
  }
  if (mode === 'transcode') {
    return 'transcode'
  }
  return 'auto'
}

export const normalizePerformanceProfile = (
  profile: WdioPuppeteerVideoServicePerformanceProfile | undefined,
): WdioPuppeteerVideoServicePerformanceProfile => {
  if (profile === 'ci') {
    return 'ci'
  }
  if (profile === 'parallel') {
    return 'parallel'
  }
  return 'default'
}

export const normalizeRecordingStartMode = (
  mode: WdioPuppeteerVideoServiceRecordingStartMode | undefined,
): WdioPuppeteerVideoServiceRecordingStartMode => {
  if (mode === 'fastFail') {
    return 'fastFail'
  }
  return 'blocking'
}

export const isBenignStreamWriteError = (
  error: NodeJS.ErrnoException,
): boolean => {
  if (error.code === 'EPIPE') {
    return true
  }

  const message = error.message.toLowerCase()
  return (
    message.includes('cannot call write after a stream was destroyed') ||
    message.includes('write after end')
  )
}

export const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return String(error)
}

export const getEffectiveMaxFilenameLength = (
  options: Pick<
    WdioPuppeteerVideoServiceOptions,
    'maxFileNameLength' | 'outputDir'
  >,
): number => {
  const platformDefault =
    process.platform === 'win32'
      ? WINDOWS_DEFAULT_MAX_FILENAME_LENGTH
      : DEFAULT_MAX_FILENAME_LENGTH
  const configuredMax = options.maxFileNameLength
    ? Math.floor(options.maxFileNameLength)
    : platformDefault

  let effectiveMax = configuredMax
  if (process.platform === 'win32') {
    const absoluteOutputDir = path.resolve(options.outputDir || 'videos')
    const remainingPathBudget =
      WINDOWS_MAX_PATH_LENGTH - absoluteOutputDir.length - 1
    if (remainingPathBudget > 0) {
      effectiveMax = Math.min(effectiveMax, remainingPathBudget)
    }
  }

  return Math.max(MIN_SAFE_FILENAME_LENGTH, effectiveMax)
}

export const computeMaxSlugLength = (
  options: Pick<
    WdioPuppeteerVideoServiceOptions,
    'maxFileNameLength' | 'outputDir'
  >,
): number => {
  const effectiveMaxFilenameLength = getEffectiveMaxFilenameLength(options)
  return Math.max(16, effectiveMaxFilenameLength - SEGMENT_SUFFIX_MAX_LENGTH)
}

const normalizeStringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined
  }

  return value.filter(
    (entry): entry is string =>
      typeof entry === 'string' && entry.trim().length > 0,
  )
}

const toRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  return value as Record<string, unknown>
}
