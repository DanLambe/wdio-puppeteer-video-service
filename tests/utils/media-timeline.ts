import { spawnSync } from 'node:child_process'

export type SolidColor = 'blue' | 'green' | 'red'

export interface ColorSpan {
  readonly color: SolidColor
  /** Seconds, from the first decoded frame's timestamp. */
  readonly start: number
  readonly end: number
}

export interface DecodedTimeline {
  readonly codecLine: string
  /** Decoded frames, each with its own timestamp; no frames are invented. */
  readonly frames: number
  readonly spans: ColorSpan[]
}

const run = (ffmpegPath: string, args: string[]) => {
  const result = spawnSync(ffmpegPath, args, { maxBuffer: 1 << 28 })
  if (result.status !== 0) {
    throw new Error(
      `FFmpeg failed (${String(result.status)}): ${result.stderr.toString()}`,
    )
  }
  return result
}

const classify = (red: number, green: number, blue: number): SolidColor => {
  if (red > green && red > blue) {
    return 'red'
  }
  return green > blue ? 'green' : 'blue'
}

/**
 * Decodes every frame at its own timestamp and merges runs of one solid
 * color. The last frame lasts one step of `fps`, as a player holds it.
 * `passthroughArgs` keeps FFmpeg from repeating frames onto a constant rate.
 */
export const decodeColorTimeline = (
  ffmpegPath: string,
  filePath: string,
  fps: number,
  passthroughArgs: readonly string[],
): DecodedTimeline => {
  const info = run(ffmpegPath, [
    '-hide_banner',
    '-i',
    filePath,
    '-vf',
    'showinfo',
    ...passthroughArgs,
    '-f',
    'null',
    '-',
  ]).stderr.toString()
  const timestamps = [...info.matchAll(/pts_time:\s*([\d.]+)/gu)].map((match) =>
    Number(match[1]),
  )
  const pixels = run(ffmpegPath, [
    '-v',
    'error',
    '-i',
    filePath,
    '-vf',
    'scale=1:1:flags=area,format=rgb24',
    ...passthroughArgs,
    '-f',
    'rawvideo',
    '-',
  ]).stdout
  const colors: SolidColor[] = []
  for (let offset = 0; offset + 2 < pixels.length; offset += 3) {
    colors.push(
      classify(
        pixels[offset] ?? 0,
        pixels[offset + 1] ?? 0,
        pixels[offset + 2] ?? 0,
      ),
    )
  }
  if (colors.length !== timestamps.length) {
    throw new Error(
      `Decoded ${colors.length.toString()} frames but ${timestamps.length.toString()} timestamps`,
    )
  }
  const origin = timestamps[0] ?? 0
  const spans: Array<{ color: SolidColor; start: number; end: number }> = []
  colors.forEach((color, index) => {
    const start = (timestamps[index] ?? 0) - origin
    const end = (timestamps[index + 1] ?? start + origin + 1 / fps) - origin
    const last = spans.at(-1)
    if (last?.color === color) {
      last.end = end
    } else {
      spans.push({ color, start, end })
    }
  })
  return {
    codecLine: /Video: [^\n]*/u.exec(info)?.[0] ?? '',
    frames: colors.length,
    spans: spans.map((span) => ({
      ...span,
      start: Number(span.start.toFixed(3)),
      end: Number(span.end.toFixed(3)),
    })),
  }
}

/** A solid-color PNG of the given size, drawn by FFmpeg. */
export const solidPng = (
  ffmpegPath: string,
  color: SolidColor,
  width: number,
  height: number,
): Buffer => {
  return run(ffmpegPath, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=${color}:s=${width.toString()}x${height.toString()}`,
    '-frames:v',
    '1',
    '-c:v',
    'png',
    '-f',
    'image2pipe',
    '-',
  ]).stdout
}
