import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

type FrameworkMode = 'jasmine' | 'cucumber'
type FfmpegDetectionResult = {
  available: boolean
  resolvedPath?: string
  checkedCandidates: string[]
}

const FFMPEG_CHECK_TIMEOUT_MS = 5_000
const require = createRequire(import.meta.url)

const requestedMode = process.argv[2] || 'both'

const resolveFrameworkOrder = (mode: string): FrameworkMode[] => {
  if (mode === 'both') {
    return ['jasmine', 'cucumber']
  }
  if (mode === 'jasmine' || mode === 'cucumber') {
    return [mode]
  }
  return []
}

const frameworkOrder: FrameworkMode[] = resolveFrameworkOrder(requestedMode)

if (frameworkOrder.length === 0) {
  console.error(
    `[e2e:frameworks] Invalid mode "${requestedMode}". Use jasmine, cucumber, or both.`,
  )
  process.exit(1)
}

const frameworkConfigMap: Record<
  FrameworkMode,
  {
    configPath: string
    resultsDirName: string
  }
> = {
  jasmine: {
    configPath: 'tests/wdio.jasmine.conf.ts',
    resultsDirName: 'jasmine',
  },
  cucumber: {
    configPath: 'tests/wdio.cucumber.conf.ts',
    resultsDirName: 'cucumber',
  },
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

const runWdioFramework = async (
  framework: FrameworkMode,
  ffmpegDetection: FfmpegDetectionResult,
): Promise<void> => {
  const target = frameworkConfigMap[framework]
  const nodeCommand = process.execPath
  const wdioCliPath = path.resolve('node_modules/@wdio/cli/bin/wdio.js')
  const resultsDir = path.resolve('tests/results', target.resultsDirName)
  const configPath = path.resolve(target.configPath)

  console.log(
    `[e2e:frameworks] Starting ${framework} run. Artifacts => ${resultsDir}`,
  )

  await new Promise<void>((resolve, reject) => {
    const child = spawn(nodeCommand, [wdioCliPath, 'run', configPath], {
      stdio: 'inherit',
      env: {
        ...process.env,
        ...(ffmpegDetection.resolvedPath
          ? { FFMPEG_PATH: ffmpegDetection.resolvedPath }
          : {}),
        WDIO_RESULTS_DIR: resultsDir,
        WDIO_EXPECT_VIDEOS: ffmpegDetection.available ? '1' : '0',
      },
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(`[e2e:frameworks] ${framework} run failed with code ${code}`),
      )
    })
  })

  console.log(`[e2e:frameworks] Completed ${framework} run.`)
}

const ffmpegDetection = await detectFfmpeg()
if (!ffmpegDetection.available) {
  console.warn(
    `[e2e:frameworks] FFmpeg was not detected (${ffmpegDetection.checkedCandidates.join(', ') || 'no candidates'}). WDIO will run, but video artifact assertions are skipped.`,
  )
}

for (const framework of frameworkOrder) {
  // Run sequentially so results and logs stay isolated per framework.
  await runWdioFramework(framework, ffmpegDetection)
}

console.log('[e2e:frameworks] All requested framework runs completed.')
