import WdioPuppeteerVideoServiceRuntime from '../../src/service.js'
import type {
  ArtifactNamingOptions,
  CaptureOptions,
  ConcurrencyOptions,
  FailurePolicy,
  LogLevel,
  Mp4Mode,
  OutputFormat,
  ProcessingOptions,
  ProcessingTranscodeOptions,
  RecordingFilterOptions,
  RecordingOptions,
  ServiceProfile,
  WdioPuppeteerVideoServiceOptions,
} from '../../src/types.js'

/**
 * Test-only adapter for the 0.8 characterization cases. Production code never
 * accepts this shape; direct 1.0 contract tests exercise the grouped surface.
 */
export interface CharacterizedServiceOptions {
  outputDir?: string
  saveAllVideos?: boolean
  videoWidth?: number
  videoHeight?: number
  fps?: number
  recordOnRetries?: boolean
  specLevelRecording?: boolean
  skipViewPortKickoff?: boolean
  segmentOnWindowSwitch?: boolean
  maxConcurrentRecordings?: number
  maxGlobalRecordings?: number
  recordingStartMode?: 'blocking' | 'fastFail'
  recordingStartTimeoutMs?: number
  globalRecordingLockDir?: string
  postProcessMode?: 'immediate' | 'deferred'
  includeSpecPatterns?: string[]
  excludeSpecPatterns?: string[]
  includeTagPatterns?: string[]
  excludeTagPatterns?: string[]
  performanceProfile?: ServiceProfile
  logLevel?: LogLevel
  failurePolicy?: FailurePolicy
  maxFileNameLength?: number
  fileNameOverflowStrategy?: 'truncate' | 'session'
  fileNameStyle?: 'test' | 'testFull' | 'session' | 'sessionFull'
  ffmpegPath?: string
  ffmpegTimeoutMs?: number
  outputFormat?: OutputFormat
  mp4Mode?: Mp4Mode
  transcode?: ProcessingTranscodeOptions
  mergeSegments?: {
    enabled?: boolean
    deleteSegments?: boolean
  }
}

export const groupCharacterizedOptions = (
  options: CharacterizedServiceOptions = {},
): WdioPuppeteerVideoServiceOptions => {
  const grouped: WdioPuppeteerVideoServiceOptions = {}
  copyRootOptions(grouped, options)

  const recording = createRecordingOptions(options)
  if (Object.keys(recording).length > 0) {
    grouped.recording = recording
  }

  const capture = createCaptureOptions(options)
  if (Object.keys(capture).length > 0) {
    grouped.capture = capture
  }

  const processing = createProcessingOptions(options)
  if (Object.keys(processing).length > 0) {
    grouped.processing = processing
  }

  const concurrency = createConcurrencyOptions(options)
  if (Object.keys(concurrency).length > 0) {
    grouped.concurrency = concurrency
  }

  const naming = createNamingOptions(options)
  if (Object.keys(naming).length > 0) {
    grouped.artifacts = { naming }
  }

  return grouped
}

export default class WdioPuppeteerVideoService extends WdioPuppeteerVideoServiceRuntime {
  constructor(options: CharacterizedServiceOptions = {}) {
    super(groupCharacterizedOptions(options))
  }
}

const copyRootOptions = (
  target: WdioPuppeteerVideoServiceOptions,
  source: CharacterizedServiceOptions,
): void => {
  if (source.outputDir !== undefined) {
    target.outputDir = source.outputDir
  }
  if (source.performanceProfile !== undefined) {
    target.profile = source.performanceProfile
  }
  if (source.logLevel !== undefined) {
    target.logLevel = source.logLevel
  }
  if (source.failurePolicy !== undefined) {
    target.failurePolicy = source.failurePolicy
  }
}

const createRecordingOptions = (
  source: CharacterizedServiceOptions,
): RecordingOptions => {
  const recording: RecordingOptions = {}
  if (source.specLevelRecording !== undefined) {
    recording.scope = source.specLevelRecording ? 'spec' : 'test'
  }
  if (source.recordOnRetries !== undefined) {
    recording.attempts = source.recordOnRetries ? 'retries' : 'all'
  }
  if (source.saveAllVideos !== undefined) {
    recording.retain = source.saveAllVideos ? 'all' : 'failures'
  } else if (source.recordOnRetries) {
    recording.retain = 'retries'
  }
  if (source.segmentOnWindowSwitch !== undefined) {
    recording.windowChanges = source.segmentOnWindowSwitch
      ? 'segment'
      : 'ignore'
  }

  const filters = createFilterOptions(source)
  if (Object.keys(filters).length > 0) {
    recording.filters = filters
  }
  return recording
}

const createFilterOptions = (
  source: CharacterizedServiceOptions,
): RecordingFilterOptions => {
  const filters: RecordingFilterOptions = {}
  if (source.includeSpecPatterns !== undefined) {
    filters.includeSpecs = source.includeSpecPatterns
  }
  if (source.excludeSpecPatterns !== undefined) {
    filters.excludeSpecs = source.excludeSpecPatterns
  }
  if (source.includeTagPatterns !== undefined) {
    filters.includeTags = source.includeTagPatterns
  }
  if (source.excludeTagPatterns !== undefined) {
    filters.excludeTags = source.excludeTagPatterns
  }
  return filters
}

const createCaptureOptions = (
  source: CharacterizedServiceOptions,
): CaptureOptions => {
  const capture: CaptureOptions = {}
  if (source.videoWidth !== undefined || source.videoHeight !== undefined) {
    capture.viewport = {
      width: source.videoWidth ?? 1280,
      height: source.videoHeight ?? 720,
    }
  }
  if (source.fps !== undefined) {
    capture.fps = source.fps
  }
  if (source.skipViewPortKickoff !== undefined) {
    capture.framePriming = !source.skipViewPortKickoff
  }
  return capture
}

const createProcessingOptions = (
  source: CharacterizedServiceOptions,
): ProcessingOptions => {
  const processing: ProcessingOptions = {}
  if (source.outputFormat !== undefined) {
    processing.format = source.outputFormat
  }
  if (source.mp4Mode !== undefined) {
    processing.mp4Mode = source.mp4Mode
  }
  if (source.postProcessMode !== undefined) {
    processing.timing =
      source.postProcessMode === 'deferred' ? 'after-worker' : 'after-test'
  }
  if (source.ffmpegPath !== undefined || source.ffmpegTimeoutMs !== undefined) {
    processing.ffmpeg = {
      ...(source.ffmpegPath !== undefined ? { path: source.ffmpegPath } : {}),
      ...(source.ffmpegTimeoutMs !== undefined
        ? { timeoutMs: source.ffmpegTimeoutMs }
        : {}),
    }
  }
  if (source.transcode !== undefined) {
    processing.transcode = source.transcode
  }
  if (source.mergeSegments !== undefined) {
    processing.merge = source.mergeSegments
  }
  return processing
}

const createConcurrencyOptions = (
  source: CharacterizedServiceOptions,
): ConcurrencyOptions => {
  const concurrency: ConcurrencyOptions = {}
  if (source.maxConcurrentRecordings !== undefined) {
    concurrency.maxRecordingsPerProcess = source.maxConcurrentRecordings
  }
  if (source.maxGlobalRecordings !== undefined) {
    concurrency.maxRecordingsGlobal = source.maxGlobalRecordings
  }
  if (source.recordingStartMode !== undefined) {
    concurrency.startMode =
      source.recordingStartMode === 'fastFail' ? 'fast-fail' : 'blocking'
  }
  if (source.recordingStartTimeoutMs !== undefined) {
    concurrency.startTimeoutMs = source.recordingStartTimeoutMs
  }
  if (source.globalRecordingLockDir !== undefined) {
    concurrency.lockDir = source.globalRecordingLockDir
  }
  return concurrency
}

const createNamingOptions = (
  source: CharacterizedServiceOptions,
): ArtifactNamingOptions => {
  const naming: ArtifactNamingOptions = {}
  if (source.fileNameStyle !== undefined) {
    naming.style =
      source.fileNameStyle === 'testFull'
        ? 'test-full'
        : source.fileNameStyle === 'sessionFull'
          ? 'session-full'
          : source.fileNameStyle
  }
  if (source.maxFileNameLength !== undefined) {
    naming.maxLength = source.maxFileNameLength
  }
  if (source.fileNameOverflowStrategy !== undefined) {
    naming.overflow = source.fileNameOverflowStrategy
  }
  return naming
}
