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
  const formatMatch = /Input #0,\s*([^,\r\n]+(?:,[^\r\n]+)?),\s*from/.exec(
    output,
  )
  const format = formatMatch?.[1]?.toLowerCase() ?? ''
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
  const streamMatch =
    /Video:\s*([a-zA-Z0-9_-]+)[^\r\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(output)
  if (!streamMatch) {
    throw new Error(
      'Unable to determine video stream details from FFmpeg output',
    )
  }

  return {
    codec: streamMatch[1]?.toLowerCase() ?? '',
    width: Number(streamMatch[2]),
    height: Number(streamMatch[3]),
  }
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
        settle(
          new Error(
            `Media decode failed for ${filePath} with FFmpeg exit code ${String(code)}${details ? `: ${details}` : ''}`,
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
