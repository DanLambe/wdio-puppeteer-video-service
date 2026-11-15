import type { CaptureCrop, OutputFormat } from '../types.js'

// libvpx's fastest realtime speed. Puppeteer derives it from the host's CPU
// count, so a 4-CPU CI runner encodes 1080p VP9 at about 7 frames per second on
// one core: slower than the capture rate, so every stop has a backlog to drain.
// On a busy full-HD test page, speed 8 encoded about 13 times faster than speed
// 2 at near-identical SSIM, with files about 2.7 times larger.
const VP9_REALTIME_SPEED = 8

/** The recorder's Matroska stream, read from FFmpeg's standard input. */
export const LIVE_INPUT = 'pipe:0'

/** The frame size FFmpeg is told to expect. */
export interface CaptureCanvas {
  readonly width: number
  readonly height: number
}

/**
 * Everything about a recording that decides FFmpeg's arguments, apart from
 * where its frames are read from and where the segment is written.
 */
export interface ScreencastEncodeSettings {
  readonly canvas: CaptureCanvas
  /** In device pixels. */
  readonly crop?: Readonly<CaptureCrop>
  readonly format: OutputFormat
  readonly quality: number
  readonly scale: number
}

export interface ScreencastOutputArguments {
  readonly format: OutputFormat
  /** The segment file FFmpeg writes; it replaces any placeholder there. */
  readonly outputPath: string
  readonly quality: number
  readonly scale?: number
}

/**
 * FFmpeg's arguments for a recording. A live encode reads the recorder's
 * stream from `pipe:0`; the end-of-recording encode reads the same stream
 * from its spool file. Every filter, encoder and muxer argument is shared, so
 * the two differ only in `input`.
 */
export const createFfmpegArguments = (
  options: ScreencastOutputArguments,
  dimensions: CaptureCanvas,
  crop: Readonly<CaptureCrop> | undefined,
  input: string = LIVE_INPUT,
): string[] => {
  const { width, height } = dimensions
  const filters = [
    `crop='min(${width},iw):min(${height},ih):0:0'`,
    `pad=${width}:${height}:0:0`,
  ]
  // `scale` defaults to 1, which is truthy, so an unconfigured recording would
  // otherwise pay for a full Lanczos resample of every frame to produce the
  // frame it already had. `speed` is applied to the frame timestamps.
  if (crop) {
    filters.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`)
  }
  if (options.scale !== undefined && options.scale !== 1) {
    filters.push(`scale=iw*${options.scale}:-1:flags=lanczos`)
  }
  // RGB input would otherwise select VP9 profile 1 (planar RGB): about 2.5
  // times the size of 4:2:0, and not playable by Safari or hardware decoders.
  filters.push('format=yuv420p')
  return [
    ['-loglevel', 'error'],
    // Frames arrive once each, timestamped on the grid, so the video holds an
    // unchanged page instead of decoding and encoding it at every position.
    // Keep input buffering and probing at their defaults; a tiny probe size or
    // `-avioflags direct` loses the first frames.
    ['-f', 'matroska', '-i', input],
    ['-an', '-threads', '1', '-b:v', '0'],
    ['-vcodec', 'vp9', '-crf', `${options.quality}`],
    ['-deadline', 'realtime'],
    ['-cpu-used', `${VP9_REALTIME_SPEED}`],
    // Disable lookahead to reduce buffering and stop latency in the realtime
    // capture encoder: libvpx otherwise holds frames back and encodes them all
    // when recording stops, while a tab switch or the test's end waits.
    ['-lag-in-frames', '0'],
    // WebM keeps frame timestamps by default. MP4 would otherwise repeat each
    // frame onto a constant rate; its `hybrid_fragmented` flag already needs an
    // FFmpeg recent enough to accept `-fps_mode`.
    options.format === 'mp4'
      ? [
          '-fps_mode',
          'passthrough',
          '-movflags',
          'hybrid_fragmented',
          '-f',
          'mp4',
        ]
      : [
          '-f',
          'webm',
          // FFmpeg writes the duration and seek index when it finishes a file
          // it can seek in. Short clusters, flushed as written, keep what an
          // encoder killed mid-recording leaves behind decodable to within
          // about a second of what it had encoded.
          '-cluster_time_limit',
          '1000',
          '-flush_packets',
          '1',
        ],
    ['-vf', filters.join()],
    // Replaces the empty file that reserved the path.
    ['-y', options.outputPath],
  ].flat()
}
