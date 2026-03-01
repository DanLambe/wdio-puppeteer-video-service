export type WdioPuppeteerVideoServiceLogLevel =
  | 'trace'
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'silent'

export type WdioPuppeteerVideoServiceFileNameOverflowStrategy =
  | 'truncate'
  | 'session'

export type WdioPuppeteerVideoServiceFileNameStyle =
  | 'test'
  | 'session'
  | 'sessionFull'

export type WdioPuppeteerVideoServiceMp4Mode = 'auto' | 'direct' | 'transcode'
export type WdioPuppeteerVideoServicePerformanceProfile =
  | 'default'
  | 'parallel'
  | 'ci'
export type WdioPuppeteerVideoServicePostProcessMode = 'immediate' | 'deferred'
export type WdioPuppeteerVideoServiceRecordingStartMode =
  | 'blocking'
  | 'fastFail'

export interface WdioPuppeteerVideoServiceOptions {
  /**
   * Directory where videos will be saved.
   * @default 'videos'
   */
  outputDir?: string

  /**
   * Whether to save all videos or only for failed tests.
   * @default false
   */
  saveAllVideos?: boolean

  /**
   * Video frame width.
   * @default 1280
   */
  videoWidth?: number

  /**
   * Video frame height.
   * @default 720
   */
  videoHeight?: number

  /**
   * Video frame rate.
   * @default 30
   */
  fps?: number

  /**
   * Record only retry attempts (`attempt > 0`) instead of every first run.
   * WDIO `specFileRetries` worker retries are also treated as retry attempts.
   *
   * This reduces capture overhead for mostly-green suites.
   *
   * @default false
   */
  recordOnRetries?: boolean

  /**
   * Record once per spec file instead of per test/scenario.
   *
   * In this mode, recording starts on the first entity that qualifies for recording
   * and finalizes in the worker `after` hook.
   *
   * @default false
   */
  specLevelRecording?: boolean

  /**
   * Skip the viewport "kickoff" resize sequence used to prime early screencast frames.
   *
   * Disabling this can reduce per-recording overhead in constrained CI environments.
   *
   * @default false
   */
  skipViewPortKickoff?: boolean

  /**
   * Controls whether window/tab switching commands create recording segments (`_partN`).
   *
   * Disabling this avoids stop/start churn around `newWindow`, `switchWindow`,
   * `switchToWindow`, and `closeWindow`, but recordings may miss activity that
   * happens in windows that were never attached for capture.
   *
   * @default true
   */
  segmentOnWindowSwitch?: boolean

  /**
   * Maximum concurrent active recorders within the current Node.js process.
   *
   * Use `0` (or omit) for no explicit limit.
   *
   * @default 0
   */
  maxConcurrentRecordings?: number

  /**
   * Maximum concurrent active recorders across WDIO worker processes on the same host.
   *
   * This uses a lock-file slot semaphore and can reduce host CPU contention in CI.
   * Use `0` (or omit) to disable the global limiter.
   *
   * @default 0
   */
  maxGlobalRecordings?: number

  /**
   * Recording start behavior when recorder slots are saturated.
   *
   * - `blocking` (default): wait for slot availability.
   * - `fastFail`: wait up to `recordingStartTimeoutMs`, then skip this segment.
   *
   * @default 'blocking'
   */
  recordingStartMode?: WdioPuppeteerVideoServiceRecordingStartMode

  /**
   * Maximum wait time (milliseconds) used by `recordingStartMode: 'fastFail'`.
   *
   * @default 2500
   */
  recordingStartTimeoutMs?: number

  /**
   * Optional directory used for global recording lock files.
   *
   * If omitted, a `.wdio-video-global-slots` directory inside `outputDir` is used.
   */
  globalRecordingLockDir?: string

  /**
   * Post-processing execution mode for ffmpeg-heavy steps (segment merge and transcode).
   *
   * - `immediate` (default): process artifacts at test finalization
   * - `deferred`: queue processing and execute in the worker `after` hook
   *
   * @default 'immediate'
   */
  postProcessMode?: WdioPuppeteerVideoServicePostProcessMode

  /**
   * Optional spec-path include patterns for deciding whether to record.
   *
   * Patterns are case-insensitive and support `*` wildcards.
   * If provided, only matching spec paths are eligible for recording.
   */
  includeSpecPatterns?: string[]

  /**
   * Optional spec-path exclude patterns for deciding whether to record.
   *
   * Patterns are case-insensitive and support `*` wildcards.
   */
  excludeSpecPatterns?: string[]

  /**
   * Optional tag include patterns for deciding whether to record.
   *
   * Primarily useful for Cucumber tag metadata.
   * Patterns are case-insensitive and support `*` wildcards.
   * If provided, at least one tag must match for recording to start.
   */
  includeTagPatterns?: string[]

  /**
   * Optional tag exclude patterns for deciding whether to record.
   *
   * Primarily useful for Cucumber tag metadata.
   * Patterns are case-insensitive and support `*` wildcards.
   */
  excludeTagPatterns?: string[]

  /**
   * Optional performance profile that applies conservative defaults for parallel workers.
   *
   * - `default`: keeps standard defaults
   * - `parallel`: when corresponding options are unset, uses lower-overhead defaults
   *   (`videoWidth: 1280`, `videoHeight: 720`, `fps: 24`, `outputFormat: webm`)
   * - `ci`: opt-in CI baseline focused on stability and throughput under contention
   *   (`videoWidth: 1280`, `videoHeight: 720`, `fps: 24`, `outputFormat: webm`,
   *   `skipViewPortKickoff: true`, `segmentOnWindowSwitch: false`,
   *   `postProcessMode: deferred`, `recordingStartMode: fastFail`,
   *   `recordingStartTimeoutMs: 2500`, `mergeSegments.enabled: false` when unset,
   *   and service `logLevel` pinned to `warn` unless explicitly set)
   *
   * Explicit user options always take precedence over profile defaults.
   *
   * @default 'default'
   */
  performanceProfile?: WdioPuppeteerVideoServicePerformanceProfile

  /**
   * Service log level.
   *
   * If omitted, the service attempts to use the WebdriverIO log level.
   * If no WDIO log level can be detected, it defaults to `warn`.
   *
   * @default inherits WDIO log level, fallback `warn`
   */
  logLevel?: WdioPuppeteerVideoServiceLogLevel

  /**
   * Maximum generated video filename length (basename including extension).
   *
   * This is especially useful for Windows path-length constrained environments.
   *
   * @default 180 on Windows, 255 on other platforms
   */
  maxFileNameLength?: number

  /**
   * Strategy used when a generated video filename would exceed limits.
   *
   * - `truncate`: keep a shortened test-title token (default)
   * - `session`: fallback to session/hash-focused naming
   *
   * @default 'truncate'
   */
  fileNameOverflowStrategy?: WdioPuppeteerVideoServiceFileNameOverflowStrategy

  /**
   * Base naming style used for generated video files.
   *
   * - `test` (default): test/scenario-oriented slug with session + hash suffix
   * - `session`: session-id-only slug using a short session token
   * - `sessionFull`: session-id-only slug using the full session id token
   *
   * Note: session-only styles can produce duplicate names across multiple tests in one session,
   * so the service appends `_runN` when needed to avoid overwriting prior artifacts.
   *
   * @default 'test'
   */
  fileNameStyle?: WdioPuppeteerVideoServiceFileNameStyle

  /**
   * Explicit path to the ffmpeg binary.
   * If omitted, the service tries `FFMPEG_PATH`, then `ffmpeg` on PATH,
   * and finally `ffmpeg-static` if it is installed in the project.
   */
  ffmpegPath?: string

  /**
   * Output container format.
   *
   * Note: Puppeteer recording uses VP9 for both `webm` and `mp4` containers.
   * If you need maximum compatibility, enable `transcode.enabled` while using `mp4`.
   *
   * @default 'webm'
   */
  outputFormat?: 'webm' | 'mp4'

  /**
   * MP4 recording strategy when `outputFormat` is `mp4`.
   *
   * - `auto` (default): attempts direct MP4 if ffmpeg supports Puppeteer's MP4 pipeline, otherwise falls back to transcode.
   * - `direct`: always use Puppeteer direct MP4 recording.
   * - `transcode`: always record WebM then transcode to H.264 MP4.
   *
   * `transcode.enabled` still forces transcode when set to `true`.
   *
   * @default 'auto'
   */
  mp4Mode?: WdioPuppeteerVideoServiceMp4Mode

  /**
   * Optional post-processing step to transcode recordings into an H.264 MP4 for maximum compatibility.
   *
   * The transcode step only runs when `outputFormat` is set to `mp4`.
   */
  transcode?: WdioPuppeteerVideoServiceTranscodeOptions

  /**
   * Optional post-processing step to merge per-window recording parts into one continuous file per test.
   */
  mergeSegments?: WdioPuppeteerVideoServiceMergeOptions

  /**
   * @deprecated Use `transcode.ffmpegArgs` instead.
   */
  ffmpegArgs?: string[]
}

export interface WdioPuppeteerVideoServiceTranscodeOptions {
  /**
   * Enable H.264 MP4 transcoding when `outputFormat` is `mp4`.
   * @default false
   */
  enabled?: boolean

  /**
   * Delete the intermediate recording after successful transcode.
   * @default true
   */
  deleteOriginal?: boolean

  /**
   * Extra ffmpeg arguments inserted before the output file.
   *
   * Example: `['-crf', '28', '-preset', 'veryfast']`
   */
  ffmpegArgs?: string[]
}

export interface WdioPuppeteerVideoServiceMergeOptions {
  /**
   * Enable merging `*_partN` files into a single test video.
   * @default false
   */
  enabled?: boolean

  /**
   * Delete segment part files after a successful merge.
   * @default true
   */
  deleteSegments?: boolean
}
