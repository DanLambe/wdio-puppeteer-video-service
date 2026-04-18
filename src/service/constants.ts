import type { WriteStream } from 'node:fs'
import type {
  WdioPuppeteerVideoServiceLogLevel,
  WdioPuppeteerVideoServiceOptions,
  WdioPuppeteerVideoServiceTranscodeOptions,
} from '../types.js'

export type OutputFormat = NonNullable<
  WdioPuppeteerVideoServiceOptions['outputFormat']
>

export type ResolvedTranscodeOptions = Required<
  Pick<WdioPuppeteerVideoServiceTranscodeOptions, 'deleteOriginal'>
> &
  Pick<WdioPuppeteerVideoServiceTranscodeOptions, 'ffmpegArgs'>

export interface ActiveSegment {
  recordingPath: string
  outputPath: string
  outputFormat: OutputFormat
  recordingFormat: OutputFormat
  transcode: boolean
  transcodeOptions: ResolvedTranscodeOptions
  writeStream: WriteStream
  writeStreamDone: Promise<void>
  writeStreamErrored: boolean
  writeStreamErrorMessage?: string
  onWriteStreamError: (error: NodeJS.ErrnoException) => void
  onRecorderError: (error: unknown) => void
}

export interface DeferredTranscodeTask {
  kind: 'transcode'
  inputPath: string
  outputPath: string
  deleteOriginal: boolean
  ffmpegArgs?: string[]
}

export interface DeferredMergeTask {
  kind: 'merge'
  segmentPaths: string[]
  mergedPath: string
  deleteSegments: boolean
  transcodeToMp4?: {
    outputPath: string
    deleteOriginal: boolean
    ffmpegArgs?: string[]
  }
}

export type DeferredPostProcessTask = DeferredTranscodeTask | DeferredMergeTask

export interface MergeExecutionOptions {
  segmentPaths: string[]
  mergedPath: string
  deleteSegments: boolean
  writeFailureContext: string
  ffmpegOperation: string
}

export interface PersistedSpecRetryState {
  specRetryKey: string
  specFileRetryAttempt: number
}

export interface ResolvedRetryContext {
  explicitFrameworkRetry: number | undefined
  specFileRetryAttempt: number
  inferredEntityRetry: number | undefined
  effectiveRetryCount: number
}

export const SEGMENT_EXTENSION_TO_FORMAT: Record<string, OutputFormat> = {
  '.mp4': 'mp4',
  '.webm': 'webm',
}

export const WINDOW_SEGMENT_COMMANDS: Set<string> = new Set<string>([
  'switchWindow',
  'switchToWindow',
  'newWindow',
  'closeWindow',
])

export const ACTIVE_PAGE_TIMEOUT_MS = 2_000
export const ACTIVE_PAGE_POLL_MS = 50
export const SEGMENT_SWITCH_DELAY_MS = 50
export const WRITE_STREAM_TIMEOUT_MS = 30_000
export const FFMPEG_CHECK_TIMEOUT_MS = 5_000
export const WINDOWS_DEFAULT_MAX_FILENAME_LENGTH = 180
export const DEFAULT_MAX_FILENAME_LENGTH = 255
export const WINDOWS_MAX_PATH_LENGTH = 259
export const SEGMENT_SUFFIX_MAX_LENGTH: number = '_part9999.webm'.length
export const MIN_SAFE_FILENAME_LENGTH = 40
export const MP4_DIRECT_PROBE_TIMEOUT_MS = 5_000
export const IN_PROCESS_RECORDING_SLOT_POLL_MS = 25
export const GLOBAL_RECORDING_SLOT_POLL_MS = 100
export const GLOBAL_RECORDING_SLOT_TIMEOUT_MS = 120_000
export const GLOBAL_RECORDING_SLOT_HEARTBEAT_MS = 1_000
export const GLOBAL_RECORDING_SLOT_ACTIVE_STALE_MS = 30_000
export const DEFAULT_RECORDING_START_TIMEOUT_MS = 2_500
export const GLOBAL_RECORDING_SLOT_INVALID_STALE_MS = 5_000
export const GLOBAL_RECORDING_SLOT_DIR_NAME = '.wdio-video-global-slots'
export const SPEC_RETRY_STATE_DIR_NAME = '.wdio-video-retry-state'
export const DEFAULT_OUTPUT_DIR = 'videos'
export const SERVICE_LOG_PREFIX = '[WdioPuppeteerVideoService]'

export const LOG_LEVEL_PRIORITY: Record<
  WdioPuppeteerVideoServiceLogLevel,
  number
> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
}

export const LOG_METHOD_MAP: Record<string, (...args: unknown[]) => void> = {
  error: console.error,
  warn: console.warn,
  info: console.info,
}
