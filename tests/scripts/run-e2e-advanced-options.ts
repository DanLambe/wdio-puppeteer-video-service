import { spawn } from 'node:child_process'
import path from 'node:path'
import { detectFfmpeg, type FfmpegDetectionResult } from './ffmpeg-detection.js'

type AdvancedMode =
  | 'retry'
  | 'spec-file-retry'
  | 'spec-level'
  | 'no-segment'
  | 'test-full-style'
  | 'session-style'
  | 'session-full-style'
  | 'deferred-merge'
  | 'include-spec'
  | 'exclude-spec'

const requestedMode = process.argv[2] || 'all'

const resolveModeOrder = (mode: string): AdvancedMode[] => {
  if (mode === 'all') {
    return [
      'retry',
      'spec-file-retry',
      'spec-level',
      'no-segment',
      'test-full-style',
      'session-style',
      'session-full-style',
      'deferred-merge',
      'include-spec',
      'exclude-spec',
    ]
  }

  if (
    mode === 'retry' ||
    mode === 'spec-file-retry' ||
    mode === 'spec-level' ||
    mode === 'no-segment' ||
    mode === 'test-full-style' ||
    mode === 'session-style' ||
    mode === 'session-full-style' ||
    mode === 'deferred-merge' ||
    mode === 'include-spec' ||
    mode === 'exclude-spec'
  ) {
    return [mode]
  }

  return []
}

const modeOrder = resolveModeOrder(requestedMode)
if (modeOrder.length === 0) {
  console.error(
    `[e2e:advanced] Invalid mode "${requestedMode}". Use all, retry, spec-file-retry, spec-level, no-segment, test-full-style, session-style, session-full-style, deferred-merge, include-spec, or exclude-spec.`,
  )
  process.exit(1)
}

const runMode = async (
  mode: AdvancedMode,
  ffmpegDetection: FfmpegDetectionResult,
): Promise<void> => {
  const nodeCommand = process.execPath
  const wdioCliPath = path.resolve('node_modules/@wdio/cli/bin/wdio.js')
  const resultsDir = path.resolve('tests/results', `advanced-${mode}`)
  const configPath = path.resolve('tests/wdio.advanced.conf.ts')

  console.log(`[e2e:advanced] Starting ${mode} run. Artifacts => ${resultsDir}`)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(nodeCommand, [wdioCliPath, 'run', configPath], {
      stdio: 'inherit',
      windowsHide: true,
      env: {
        ...process.env,
        ...(ffmpegDetection.resolvedPath
          ? { FFMPEG_PATH: ffmpegDetection.resolvedPath }
          : {}),
        WDIO_ADVANCED_MODE: mode,
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
      reject(new Error(`[e2e:advanced] ${mode} run failed with code ${code}`))
    })
  })

  console.log(`[e2e:advanced] Completed ${mode} run.`)
}

const ffmpegDetection = await detectFfmpeg()
if (!ffmpegDetection.available) {
  console.warn(
    `[e2e:advanced] FFmpeg was not detected (${ffmpegDetection.checkedCandidates.join(', ') || 'no candidates'}). WDIO will run, but video artifact assertions are skipped.`,
  )
}

for (const mode of modeOrder) {
  await runMode(mode, ffmpegDetection)
}

console.log('[e2e:advanced] All requested advanced runs completed.')
