import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

type VideoMode = 'multipart' | 'merge'
type FfmpegDetectionResult = {
  available: boolean
  resolvedPath?: string
  checkedCandidates: string[]
}
const FFMPEG_CHECK_TIMEOUT_MS = 5_000
const require = createRequire(import.meta.url)

const requestedMode = process.argv[2] || 'both'
const modeOrder: VideoMode[] =
  requestedMode === 'both'
    ? ['multipart', 'merge']
    : requestedMode === 'multipart' || requestedMode === 'merge'
      ? [requestedMode]
      : []

if (modeOrder.length === 0) {
  console.error(
    `[e2e:modes] Invalid mode "${requestedMode}". Use multipart, merge, or both.`,
  )
  process.exit(1)
}

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

const detectFfmpeg = async (): Promise<FfmpegDetectionResult> => {
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

const runWdio = async (mode: VideoMode): Promise<void> => {
  const nodeCommand = process.execPath
  const wdioCliPath = path.resolve('node_modules/@wdio/cli/bin/wdio.js')
  const resultsDir = path.resolve('tests/results', mode)
  const mergeEnabled = mode === 'merge' ? '1' : '0'
  const ffmpegDetection = await detectFfmpeg()
  if (!ffmpegDetection.available) {
    console.warn(
      `[e2e:modes] FFmpeg was not detected (${ffmpegDetection.checkedCandidates.join(', ') || 'no candidates'}). WDIO will run, but video artifact assertions are skipped.`,
    )
  }

  console.log(`[e2e:modes] Starting ${mode} run. Artifacts => ${resultsDir}`)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      nodeCommand,
      [wdioCliPath, 'run', 'tests/wdio.conf.ts'],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          ...(ffmpegDetection.resolvedPath
            ? { FFMPEG_PATH: ffmpegDetection.resolvedPath }
            : {}),
          WDIO_MERGE_SEGMENTS: mergeEnabled,
          WDIO_VIDEO_MODE: mode,
          WDIO_RESULTS_DIR: resultsDir,
          WDIO_EXPECT_VIDEOS: ffmpegDetection.available ? '1' : '0',
        },
      },
    )

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`[e2e:modes] ${mode} run failed with code ${code}`))
    })
  })

  console.log(`[e2e:modes] Completed ${mode} run.`)
}

for (const mode of modeOrder) {
  // Sequential runs preserve distinct artifact folders for each mode.
  await runWdio(mode)
}

console.log('[e2e:modes] All requested runs completed successfully.')
