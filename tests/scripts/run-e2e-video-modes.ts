import { spawn } from 'node:child_process'
import path from 'node:path'
import { detectFfmpeg, type FfmpegDetectionResult } from './ffmpeg-detection.js'

type VideoMode = 'multipart' | 'merge'

const requestedMode = process.argv[2] || 'both'

let modeOrder: VideoMode[]
if (requestedMode === 'both') {
  modeOrder = ['multipart', 'merge']
} else if (requestedMode === 'multipart' || requestedMode === 'merge') {
  modeOrder = [requestedMode]
} else {
  modeOrder = []
}

if (modeOrder.length === 0) {
  console.error(
    `[e2e:modes] Invalid mode "${requestedMode}". Use multipart, merge, or both.`,
  )
  process.exit(1)
}

const runWdio = async (
  mode: VideoMode,
  ffmpegDetection: FfmpegDetectionResult,
): Promise<void> => {
  const nodeCommand = process.execPath
  const wdioCliPath = path.resolve('node_modules/@wdio/cli/bin/wdio.js')
  const resultsDir = path.resolve('tests/results', mode)
  const mergeEnabled = mode === 'merge' ? '1' : '0'

  console.log(`[e2e:modes] Starting ${mode} run. Artifacts => ${resultsDir}`)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      nodeCommand,
      [wdioCliPath, 'run', 'tests/wdio.conf.ts'],
      {
        stdio: 'inherit',
        windowsHide: true,
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

const ffmpegDetection = await detectFfmpeg()
if (!ffmpegDetection.available) {
  console.warn(
    `[e2e:modes] FFmpeg was not detected (${ffmpegDetection.checkedCandidates.join(', ') || 'no candidates'}). WDIO will run, but video artifact assertions are skipped.`,
  )
}

for (const mode of modeOrder) {
  // Sequential runs preserve distinct artifact folders for each mode.
  await runWdio(mode, ffmpegDetection)
}

console.log('[e2e:modes] All requested runs completed successfully.')
