import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

export type FfmpegDetectionResult = {
  available: boolean
  resolvedPath?: string
  checkedCandidates: string[]
}

const FFMPEG_CHECK_TIMEOUT_MS = 5_000
const require = createRequire(import.meta.url)

const resolveOptionalFfmpegStaticPath = (): string | undefined => {
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

const canExecuteFfmpeg = async (ffmpegPath: string): Promise<boolean> => {
  return await new Promise<boolean>((resolve) => {
    const proc = spawn(ffmpegPath, ['-version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
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

export const detectFfmpeg = async (): Promise<FfmpegDetectionResult> => {
  const envPath = process.env.FFMPEG_PATH?.trim()
  const staticPath = resolveOptionalFfmpegStaticPath()
  const candidatePaths = [envPath, 'ffmpeg', staticPath]
  const checkedCandidates: string[] = []
  const seen = new Set<string>()

  for (const candidate of candidatePaths) {
    if (!candidate) {
      continue
    }
    const normalizedCandidate = candidate.trim()
    if (!normalizedCandidate || seen.has(normalizedCandidate)) {
      continue
    }
    seen.add(normalizedCandidate)
    checkedCandidates.push(normalizedCandidate)

    if (await canExecuteFfmpeg(normalizedCandidate)) {
      return {
        available: true,
        resolvedPath: normalizedCandidate,
        checkedCandidates,
      }
    }
  }

  return {
    available: false,
    checkedCandidates,
  }
}
