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
export type AllureAttachmentMode = 'failures' | 'retained'

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
  /** Limit local workers within one WDIO invocation; 0 disables the limit. @default 0 */
  maxRecordingsGlobal?: number
  /** @default 'blocking' */
  startMode?: RecordingStartMode
  /** @default 2500 */
  startTimeoutMs?: number
  /** Number of deferred jobs that may run concurrently in this worker. @default 1 */
  maxPostProcessesPerProcess?: number
  /** Limit local workers within one WDIO invocation; 0 disables it. The `ci` profile defaults to 1. @default 0 */
  maxPostProcessesGlobal?: number
  /** @default 'blocking' */
  postProcessStartMode?: RecordingStartMode
  /** @default 2500 */
  postProcessStartTimeoutMs?: number
  /** Shared local base directory. Each WDIO invocation uses its own run subdirectory. */
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

export interface AllureIntegrationOptions {
  /** Attach only failed-test videos or every retained video. @default 'failures' */
  attach?: AllureAttachmentMode
  /** Skip an individual video attachment when its size exceeds this limit. */
  maxBytes?: number
}

export interface IntegrationOptions {
  /** Enables lazy integration with an installed `@wdio/allure-reporter`. */
  allure?: AllureIntegrationOptions
}

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
export interface ResolvedRecordingFilterOptions {
  readonly includeSpecs: readonly string[]
  readonly excludeSpecs: readonly string[]
  readonly includeTags: readonly string[]
  readonly excludeTags: readonly string[]
}

export interface ResolvedRecordingOptions {
  readonly scope: RecordingScope
  readonly attempts: RecordingAttempts
  readonly retain: RecordingRetention
  readonly windowChanges: WindowChangeBehavior
  readonly filters: ResolvedRecordingFilterOptions
}

export interface ResolvedCaptureOptions {
  readonly viewport: 'current' | Readonly<CaptureViewport>
  readonly fps: number
  readonly quality: number
  readonly scale: number
  readonly speed: number
  readonly crop?: Readonly<CaptureCrop>
  readonly framePriming: boolean
  readonly connectionTimeoutMs: number
}

export interface ResolvedProcessingFfmpegOptions {
  readonly path?: string
  readonly timeoutMs: number
}

export interface ResolvedProcessingTranscodeOptions {
  readonly enabled: boolean
  readonly deleteOriginal: boolean
  readonly ffmpegArgs?: readonly string[]
}

export interface ResolvedProcessingMergeOptions {
  readonly enabled: boolean
  readonly deleteSegments: boolean
}

export interface ResolvedProcessingOptions {
  readonly format: OutputFormat
  readonly mp4Mode: Mp4Mode
  readonly timing: ProcessingTiming
  readonly ffmpeg: ResolvedProcessingFfmpegOptions
  readonly transcode: ResolvedProcessingTranscodeOptions
  readonly merge: ResolvedProcessingMergeOptions
}

export interface ResolvedConcurrencyOptions {
  readonly maxRecordingsPerProcess: number
  readonly maxRecordingsGlobal: number
  readonly startMode: RecordingStartMode
  readonly startTimeoutMs: number
  readonly maxPostProcessesPerProcess: number
  readonly maxPostProcessesGlobal: number
  readonly postProcessStartMode: RecordingStartMode
  readonly postProcessStartTimeoutMs: number
  readonly lockDir?: string
}

export interface ResolvedArtifactNamingOptions {
  readonly style: ArtifactNameStyle
  readonly maxLength: number
  readonly overflow: ArtifactNameOverflowStrategy
}

export interface ResolvedArtifactOptions {
  readonly naming: ResolvedArtifactNamingOptions
}

export interface ResolvedAllureIntegrationOptions {
  readonly attach: AllureAttachmentMode
  readonly maxBytes?: number
}

export interface ResolvedIntegrationOptions {
  readonly allure?: ResolvedAllureIntegrationOptions
}

export interface ResolvedWdioPuppeteerVideoServiceOptions {
  readonly outputDir: string
  readonly recording: ResolvedRecordingOptions
  readonly capture: ResolvedCaptureOptions
  readonly processing: ResolvedProcessingOptions
  readonly concurrency: ResolvedConcurrencyOptions
  readonly artifacts: ResolvedArtifactOptions
  readonly integrations: ResolvedIntegrationOptions
  readonly profile: ServiceProfile
  readonly logLevel: LogLevel
  readonly failurePolicy: FailurePolicy
}
