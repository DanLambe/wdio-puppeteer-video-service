import { spawn } from 'node:child_process'
import path from 'node:path'
import { detectFfmpeg, type FfmpegDetectionResult } from './ffmpeg-detection.js'

type FrameworkMode = 'jasmine' | 'cucumber'

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
      windowsHide: true,
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
