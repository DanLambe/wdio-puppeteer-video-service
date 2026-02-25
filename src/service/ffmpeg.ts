import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

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
