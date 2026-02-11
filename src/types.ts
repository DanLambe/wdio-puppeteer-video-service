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
export type WdioPuppeteerVideoServicePerformanceProfile = 'default' | 'parallel'

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
   * Optional performance profile that applies conservative defaults for parallel workers.
   *
   * - `default`: keeps standard defaults
   * - `parallel`: when corresponding options are unset, uses lower-overhead defaults
   *   (`videoWidth: 1280`, `videoHeight: 720`, `fps: 24`, `outputFormat: webm`)
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
