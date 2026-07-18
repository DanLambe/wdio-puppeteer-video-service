export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent'

export type FailurePolicy = 'warn' | 'error'
export type ServiceProfile = 'default' | 'parallel' | 'ci'
export type RecordingScope = 'test' | 'spec'
export type RecordingAttempts = 'all' | 'retries'
export type RecordingRetention = 'failures' | 'retries' | 'all'
export type WindowChangeBehavior = 'segment' | 'ignore'
export type OutputFormat = 'webm' | 'mp4'
export type Mp4Mode = 'auto' | 'direct' | 'transcode'
export type ProcessingTiming = 'after-test' | 'after-worker'
export type RecordingStartMode = 'blocking' | 'fast-fail'
export type ArtifactNameOverflowStrategy = 'truncate' | 'session'
export type ArtifactNameStyle =
  | 'test'
  | 'test-full'
  | 'session'
  | 'session-full'

export interface RecordingFilterOptions {
  includeSpecs?: string[]
  excludeSpecs?: string[]
  includeTags?: string[]
  excludeTags?: string[]
}

export interface RecordingOptions {
  /** @default 'test' */
  scope?: RecordingScope
  /** @default 'all' */
  attempts?: RecordingAttempts
  /** @default 'failures' */
  retain?: RecordingRetention
  /** @default 'segment' */
  windowChanges?: WindowChangeBehavior
  filters?: RecordingFilterOptions
}

export interface CaptureViewport {
  width: number
  height: number
}

export interface CaptureCrop extends CaptureViewport {
  x: number
  y: number
}

export interface CaptureOptions {
  /** Use the current browser viewport or temporarily size capture initialization. @default 'current' */
  viewport?: 'current' | CaptureViewport
  /** @default 30 */
  fps?: number
  /** FFmpeg constant-rate factor from 0 (best) to 63 (smallest). @default 30 */
  quality?: number
  /** Output dimension multiplier. @default 1 */
  scale?: number
  /** Playback-speed multiplier. @default 1 */
  speed?: number
  /** Crop applied by Puppeteer before scaling. */
  crop?: CaptureCrop
  /** Whether to prime early screencast frames with the viewport warmup. @default true */
  framePriming?: boolean
  /** Maximum time to wait for WDIO's CDP-backed Puppeteer connection. @default 10000 */
  connectionTimeoutMs?: number
}

export interface ProcessingFfmpegOptions {
  path?: string
  /** Use 0 to disable the timeout. @default 0 */
  timeoutMs?: number
}

export interface ProcessingTranscodeOptions {
  /** @default false */
  enabled?: boolean
  /** @default true */
  deleteOriginal?: boolean
  ffmpegArgs?: string[]
}

export interface ProcessingMergeOptions {
  /** @default false */
  enabled?: boolean
  /** @default true */
  deleteSegments?: boolean
}

export interface ProcessingOptions {
  /** @default 'webm' */
  format?: OutputFormat
  /** @default 'auto' */
  mp4Mode?: Mp4Mode
  /** @default 'after-test' */
  timing?: ProcessingTiming
  ffmpeg?: ProcessingFfmpegOptions
  transcode?: ProcessingTranscodeOptions
  merge?: ProcessingMergeOptions
}

export interface ConcurrencyOptions {
  /** Use 0 for no explicit in-process limit. @default 0 */
  maxRecordingsPerProcess?: number
  /** Use 0 to disable the cross-worker limit. @default 0 */
  maxRecordingsGlobal?: number
  /** @default 'blocking' */
  startMode?: RecordingStartMode
  /** @default 2500 */
  startTimeoutMs?: number
  /** Use 0 for no explicit in-process limit. @default 0 */
  maxPostProcessesPerProcess?: number
  /** Use 0 to disable the cross-worker limit. The `ci` profile defaults to 1. @default 0 */
  maxPostProcessesGlobal?: number
  /** @default 'blocking' */
  postProcessStartMode?: RecordingStartMode
  /** @default 2500 */
  postProcessStartTimeoutMs?: number
  lockDir?: string
}

export interface ArtifactNamingOptions {
  /** @default 'test' */
  style?: ArtifactNameStyle
  /** @default 180 on Windows and 255 on other platforms */
  maxLength?: number
  /** @default 'truncate' */
  overflow?: ArtifactNameOverflowStrategy
}

export interface ArtifactOptions {
  naming?: ArtifactNamingOptions
}

/** Reserved for optional, explicitly supported integrations. */
export type IntegrationOptions = Record<string, never>

export interface WdioPuppeteerVideoServiceOptions {
  /** @default 'videos' */
  outputDir?: string
  recording?: RecordingOptions
  capture?: CaptureOptions
  processing?: ProcessingOptions
  concurrency?: ConcurrencyOptions
  artifacts?: ArtifactOptions
  integrations?: IntegrationOptions
  /** @default 'default' */
  profile?: ServiceProfile
  /** Inherits the WDIO level when omitted, with a `warn` fallback. */
  logLevel?: LogLevel
  /** @default 'warn' */
  failurePolicy?: FailurePolicy
}

/**
 * Normalized runtime representation. This is intentionally not exported from
 * the package root; it isolates the service implementation from the public API.
 */
export interface ResolvedWdioPuppeteerVideoServiceOptions {
  outputDir: string
  recordingRetain: RecordingRetention
  captureViewport: 'current' | CaptureViewport
  fps: number
  captureQuality: number
  captureScale: number
  captureSpeed: number
  captureCrop?: CaptureCrop
  framePriming: boolean
  puppeteerConnectionTimeoutMs: number
  recordOnRetries: boolean
  specLevelRecording: boolean
  segmentOnWindowSwitch: boolean
  maxConcurrentRecordings: number
  maxGlobalRecordings: number
  recordingStartMode: InternalRecordingStartMode
  recordingStartTimeoutMs: number
  maxConcurrentPostProcesses: number
  maxGlobalPostProcesses: number
  postProcessStartMode: InternalRecordingStartMode
  postProcessStartTimeoutMs: number
  globalRecordingLockDir?: string
  postProcessMode: InternalPostProcessMode
  includeSpecPatterns: string[]
  excludeSpecPatterns: string[]
  includeTagPatterns: string[]
  excludeTagPatterns: string[]
  performanceProfile: ServiceProfile
  failurePolicy: FailurePolicy
  maxFileNameLength: number
  fileNameOverflowStrategy: ArtifactNameOverflowStrategy
  fileNameStyle: InternalArtifactNameStyle
  ffmpegPath?: string
  ffmpegTimeoutMs: number
  outputFormat: OutputFormat
  mp4Mode: Mp4Mode
  transcode: ProcessingTranscodeOptions
  mergeSegments: ProcessingMergeOptions
}

export type InternalArtifactNameStyle =
  | 'test'
  | 'testFull'
  | 'session'
  | 'sessionFull'
export type InternalPostProcessMode = 'immediate' | 'deferred'
export type InternalRecordingStartMode = 'blocking' | 'fastFail'
