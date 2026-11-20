import { type ChildProcess, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  FFMPEG_CHECK_TIMEOUT_MS,
  MP4_DIRECT_PROBE_TIMEOUT_MS,
} from './constants.js'
import { Utf8TailBuffer } from './utf8-tail-buffer.js'

const requireFromPackage = createRequire(import.meta.url)

interface ProbeProcessLike {
  stdout?: NodeJS.ReadableStream | null
  stderr?: NodeJS.ReadableStream | null
  on(event: 'close', listener: (code: number | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  kill(): boolean
}

type SpawnProbeProcess = (
  ffmpegPath: string,
  args: string[],
) => ProbeProcessLike

export interface FfmpegStaticLookup {
  /** The project whose own `ffmpeg-static` is the fallback. */
  readonly cwd?: string
  readonly requireFromPackage?: (id: string) => unknown
}

/** The binary path an installed `ffmpeg-static` exports, if any. */
const loadFfmpegStatic = (
  load: (id: string) => unknown,
): string | undefined => {
  try {
    const resolved = load('ffmpeg-static')
    if (typeof resolved === 'string' && resolved.trim().length > 0) {
      return resolved
    }
  } catch {
    // optional dependency
  }
  return undefined
}

/**
 * `ffmpeg-static` as this package resolves it, as with npm's hoisting, or
 * else as the consuming project does: pnpm with an isolated or global store,
 * and Yarn Plug'n'Play, resolve a package only from a project that declares
 * it.
 */
export const resolveOptionalFfmpegStaticPath = (
  lookup: FfmpegStaticLookup = {},
): string | undefined =>
  loadFfmpegStatic(lookup.requireFromPackage ?? requireFromPackage) ??
  loadFfmpegStatic(
    createRequire(path.join(lookup.cwd ?? process.cwd(), 'package.json')),
  )

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

export interface FfmpegVersionProbe {
  /** The binary started and `-version` exited with status 0. */
  readonly ran: boolean
  readonly version: string | undefined
}

export interface ResolvedFfmpeg {
  readonly path: string
  readonly version: string | undefined
}

const spawnVersionProbeProcess: SpawnProbeProcess = (command, args) =>
  spawn(command, args, {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })

/**
 * Run `ffmpeg -version` once. It tells both whether the binary runs and which
 * version it is, so availability and version cost one spawn.
 */
export const probeFfmpegVersion = async (
  ffmpegPath: string,
  spawnProcess: SpawnProbeProcess = spawnVersionProbeProcess,
): Promise<FfmpegVersionProbe> => {
  return await new Promise<FfmpegVersionProbe>((resolve) => {
    const proc = spawnProcess(ffmpegPath, ['-version'])
    let stdout = ''
    let settled = false
    const settle = (result: FfmpegVersionProbe): void => {
      if (settled) {
        return
      }
      settled = true
      resolve(result)
    }
    const timer = setTimeout(() => {
      proc.kill()
      settle({ ran: false, version: undefined })
    }, FFMPEG_CHECK_TIMEOUT_MS)

    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    proc.on('error', () => {
      clearTimeout(timer)
      settle({ ran: false, version: undefined })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        settle({ ran: false, version: undefined })
        return
      }
      const firstLine = stdout.split(/\r?\n/u)[0]?.trim()
      const match = firstLine?.match(/^ffmpeg version\s+(\S+)/iu)
      settle({ ran: true, version: match?.[1] })
    })
  })
}

/** The first candidate that runs, with the version it reported. */
export const resolveFfmpeg = async (
  candidates: string[],
  probe: (
    ffmpegPath: string,
  ) => Promise<FfmpegVersionProbe> = probeFfmpegVersion,
): Promise<ResolvedFfmpeg | undefined> => {
  for (const candidate of candidates) {
    const result = await probe(candidate)
    if (result.ran) {
      return { path: candidate, version: result.version }
    }
  }

  return undefined
}

export const readFfmpegVersion = async (
  ffmpegPath: string,
  spawnProcess?: SpawnProbeProcess,
): Promise<string | undefined> => {
  return (await probeFfmpegVersion(ffmpegPath, spawnProcess)).version
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
    '-vcodec',
    'vp9',
    '-movflags',
    'hybrid_fragmented',
    '-f',
    'mp4',
    '-y',
    outputTarget,
  ]
  const spawnProcess = options?.spawnProcess ?? spawnDirectMp4ProbeProcess

  return await new Promise<boolean>((resolve) => {
    const proc = spawnProcess(ffmpegPath, args)
    const stderr = new Utf8TailBuffer(8_192)
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
      stderr.append(chunk)
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

      const details = stderr.finish().trim()
      if (details.length > 0) {
        options?.onProbeFailure?.(details)
      }
      settle(false)
    })
  })
}
