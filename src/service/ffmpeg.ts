import { type ChildProcess, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  FFMPEG_CHECK_TIMEOUT_MS,
  MP4_DIRECT_PROBE_TIMEOUT_MS,
} from './constants.js'

const require = createRequire(import.meta.url)

interface ProbeProcessLike {
  stderr?: NodeJS.ReadableStream | null
  on(event: 'close', listener: (code: number | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  kill(): boolean
}

type SpawnProbeProcess = (
  ffmpegPath: string,
  args: string[],
) => ProbeProcessLike

export const resolveOptionalFfmpegStaticPath = (): string | undefined => {
  try {
    const resolved = require('ffmpeg-static') as string | null
    if (typeof resolved === 'string' && resolved.trim().length > 0) {
      return resolved
    }
  } catch {
    // optional dependency
  }
  return undefined
}

export const getFfmpegCandidates = (
  configuredPath: string | undefined,
  envPath: string | undefined,
): string[] => {
  const ffmpegStaticPath = resolveOptionalFfmpegStaticPath()

  const candidates = [configuredPath, envPath, 'ffmpeg', ffmpegStaticPath]
  const uniqueCandidates: string[] = []
  const seen = new Set<string>()

  for (const candidate of candidates) {
    if (!candidate) {
      continue
    }

    const normalizedCandidate = candidate.trim()
    if (!normalizedCandidate || seen.has(normalizedCandidate)) {
      continue
    }

    seen.add(normalizedCandidate)
    uniqueCandidates.push(normalizedCandidate)
  }

  return uniqueCandidates
}

const canExecuteFfmpeg = async (ffmpegPath: string): Promise<boolean> => {
  return await new Promise<boolean>((resolve) => {
    const proc = spawn(ffmpegPath, ['-version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    })
    let settled = false
    const settle = (available: boolean) => {
      if (settled) {
        return
      }

      settled = true
      resolve(available)
    }

    const timer = setTimeout(() => {
      proc.kill()
      settle(false)
    }, FFMPEG_CHECK_TIMEOUT_MS)

    proc.on('error', () => {
      clearTimeout(timer)
      settle(false)
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      settle(code === 0)
    })
  })
}

export const resolveAvailableFfmpegPath = async (
  candidates: string[],
  isExecutable: (ffmpegPath: string) => Promise<boolean> = canExecuteFfmpeg,
): Promise<string | undefined> => {
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return candidate
    }
  }

  return undefined
}

const spawnDirectMp4ProbeProcess: SpawnProbeProcess = (
  ffmpegPath,
  args,
): ChildProcess => {
  return spawn(ffmpegPath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
}

export const probeDirectMp4Support = async (
  ffmpegPath: string,
  options?: {
    onProbeFailure?: (details: string) => void
    spawnProcess?: SpawnProbeProcess
  },
): Promise<boolean> => {
  const outputTarget = process.platform === 'win32' ? 'NUL' : '/dev/null'
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=16x16:r=1',
    '-frames:v',
    '1',
    '-c:v',
    'mpeg4',
    '-movflags',
    '+frag_keyframe+empty_moov+default_base_moof+hybrid_fragmented',
    '-f',
    'mp4',
    '-y',
    outputTarget,
  ]
  const spawnProcess = options?.spawnProcess ?? spawnDirectMp4ProbeProcess

  return await new Promise<boolean>((resolve) => {
    const proc = spawnProcess(ffmpegPath, args)
    let stderr = ''
    let settled = false
    const settle = (value: boolean) => {
      if (settled) {
        return
      }

      settled = true
      resolve(value)
    }

    const timer = setTimeout(() => {
      proc.kill()
      settle(false)
    }, MP4_DIRECT_PROBE_TIMEOUT_MS)

    proc.stderr?.on('data', (chunk) => {
      const next = stderr + chunk.toString('utf8')
      stderr = next.length > 8_192 ? next.slice(-8_192) : next
    })

    proc.on('error', () => {
      clearTimeout(timer)
      settle(false)
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        settle(true)
        return
      }

      const details = stderr.trim()
      if (details.length > 0) {
        options?.onProbeFailure?.(details)
      }
      settle(false)
    })
  })
}
