import { type ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'

export type MediaContainer = 'mp4' | 'webm'

export interface MediaProbeResult {
  container: MediaContainer
  codec: string
  width: number
  height: number
  durationSeconds: number
  frameCount: number
}

export interface MediaProbeOptions {
  /** Count only frames that differ visibly from the previous one. */
  distinctFrames?: boolean
  timeoutMs?: number
  spawnProcess?: (command: string, args: string[]) => ChildProcess
}

const DEFAULT_PROBE_TIMEOUT_MS = 30_000

const defaultSpawnProcess = (command: string, args: string[]): ChildProcess => {
  return spawn(command, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
}

const parseContainer = (output: string): MediaContainer => {
  const inputLine = output
    .split(/\r?\n/u)
    .find((line) => line.includes('Input #0,') && line.includes(', from'))
  const format = readBetween(inputLine ?? '', 'Input #0,', ', from')
    .trim()
    .toLowerCase()
  if (format.includes('webm') || format.includes('matroska')) {
    return 'webm'
  }
  if (format.includes('mp4') || format.includes('mov')) {
    return 'mp4'
  }
  throw new Error(`Unable to determine media container from FFmpeg output`)
}

const parseDurationSeconds = (output: string): number => {
  const metadataDuration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(
    output,
  )
  const decodedTimestamps = [
    ...output.matchAll(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/g),
  ]
  const durationMatch = metadataDuration ?? decodedTimestamps.at(-1)
  if (!durationMatch) {
    throw new Error('Unable to determine media duration from FFmpeg output')
  }

  const hours = Number(durationMatch[1])
  const minutes = Number(durationMatch[2])
  const seconds = Number(durationMatch[3])
  return hours * 3600 + minutes * 60 + seconds
}

const parseVideoStream = (
  output: string,
): Pick<MediaProbeResult, 'codec' | 'width' | 'height'> => {
  const videoLine = output
    .split(/\r?\n/u)
    .find((line) => line.includes('Video:'))
  const codecMatch = /Video:\s*([a-zA-Z0-9_-]+)/u.exec(videoLine ?? '')
  const dimensionsMatch = /\b(\d{2,5})x(\d{2,5})\b/u.exec(videoLine ?? '')
  if (!codecMatch || !dimensionsMatch) {
    throw new Error(
      'Unable to determine video stream details from FFmpeg output',
    )
  }

  return {
    codec: codecMatch[1]?.toLowerCase() ?? '',
    width: Number(dimensionsMatch[1]),
    height: Number(dimensionsMatch[2]),
  }
}

const readBetween = (value: string, start: string, end: string): string => {
  const startIndex = value.indexOf(start)
  if (startIndex < 0) {
    return ''
  }
  const contentStart = startIndex + start.length
  const endIndex = value.indexOf(end, contentStart)
  return endIndex < 0 ? '' : value.slice(contentStart, endIndex)
}

const parseFrameCount = (output: string): number => {
  const matches = [...output.matchAll(/frame=\s*(\d+)/g)]
  const lastMatch = matches.at(-1)
  if (!lastMatch) {
    throw new Error(
      'Unable to determine decoded frame count from FFmpeg output',
    )
  }
  return Number(lastMatch[1])
}

export const parseFfmpegProbeOutput = (output: string): MediaProbeResult => {
  return {
    container: parseContainer(output),
    ...parseVideoStream(output),
    durationSeconds: parseDurationSeconds(output),
    frameCount: parseFrameCount(output),
  }
}

export const probeMediaFile = async (
  ffmpegPath: string,
  filePath: string,
  options: MediaProbeOptions = {},
): Promise<MediaProbeResult> => {
  const spawnProcess = options.spawnProcess ?? defaultSpawnProcess
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const args = [
    '-hide_banner',
    '-nostdin',
    '-stats',
    '-i',
    filePath,
    '-map',
    '0:v:0',
    ...(options.distinctFrames ? ['-vf', 'mpdecimate'] : []),
    '-f',
    'null',
    '-',
  ]

  return new Promise<MediaProbeResult>((resolve, reject) => {
    const child = spawnProcess(ffmpegPath, args)
    let stderr = ''
    let settled = false
    let timeout: NodeJS.Timeout | undefined

    const settle = (
      error: Error | undefined,
      result?: MediaProbeResult,
    ): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
      }
      if (error) {
        reject(error)
        return
      }
      if (!result) {
        reject(new Error(`FFmpeg returned no media details for ${filePath}`))
        return
      }
      resolve(result)
    }

    child.stderr?.on('data', (chunk) => {
      const combined = stderr + chunk.toString('utf8')
      stderr = combined.length > 128_000 ? combined.slice(-128_000) : combined
    })

    child.once('error', (error) => {
      settle(
        new Error(
          `Unable to start FFmpeg media probe for ${filePath}: ${error.message}`,
        ),
      )
    })

    child.once('close', (code) => {
      if (code !== 0) {
        const details = stderr.trim().slice(-2_000)
        const detailsSuffix = details ? `: ${details}` : ''
        settle(
          new Error(
            `Media decode failed for ${filePath} with FFmpeg exit code ${String(code)}${detailsSuffix}`,
          ),
        )
        return
      }

      try {
        settle(undefined, parseFfmpegProbeOutput(stderr))
      } catch (error) {
        settle(
          error instanceof Error
            ? error
            : new Error(`Unable to parse media probe for ${filePath}`),
        )
      }
    })

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill()
        settle(
          new Error(
            `Media decode timed out for ${path.basename(filePath)} after ${timeoutMs.toString()}ms`,
          ),
        )
      }, timeoutMs)
      timeout.unref()
    }
  })
}

export interface FramePixelCounts {
  readonly total: number
  readonly green: number
  readonly red: number
}

/**
 * Decodes one frame to raw RGB and classifies its pixels. Dimension assertions
 * cannot tell a correct crop from a wrong region of the same size, so a
 * colored-region fixture plus these counts is what pins crop geometry.
 */
export const countFrameColors = async (
  ffmpegPath: string,
  filePath: string,
  atSeconds = 0.5,
  options: Pick<MediaProbeOptions, 'spawnProcess' | 'timeoutMs'> = {},
): Promise<FramePixelCounts> => {
  // Seek rather than use a `select` filter: a filtergraph argument has to
  // escape its own commas, which is easy to get subtly wrong when the command
  // is spawned without a shell and fails as "No such filter".
  const args = [
    '-v',
    'error',
    '-i',
    filePath,
    '-ss',
    atSeconds.toFixed(3),
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    'pipe:1',
  ]
  const pixels = await new Promise<Buffer>((resolve, reject) => {
    const child = options.spawnProcess
      ? options.spawnProcess(ffmpegPath, args)
      : spawn(ffmpegPath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          timeout: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        })
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(`ffmpeg pixel decode exited ${String(code)}: ${stderr}`),
        )
        return
      }
      resolve(Buffer.concat(chunks))
    })
  })

  if (pixels.length === 0 || pixels.length % 3 !== 0) {
    throw new Error(
      `FFmpeg did not return a complete RGB frame for ${filePath}`,
    )
  }
  let green = 0
  let red = 0
  for (let index = 0; index + 2 < pixels.length; index += 3) {
    const r = pixels[index] ?? 0
    const g = pixels[index + 1] ?? 0
    if (g > r * 2) {
      green += 1
    } else if (r > g * 2) {
      red += 1
    }
  }
  return { total: Math.floor(pixels.length / 3), green, red }
}
