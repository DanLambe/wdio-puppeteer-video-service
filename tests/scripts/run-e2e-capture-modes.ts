import { spawn } from 'node:child_process'
import path from 'node:path'
import { assertManifestMediaDimensions } from '../utils/manifest-media-assertions.js'
import { waitForChildProcess } from './child-process.js'
import { type E2eEnvironment, startE2eEnvironment } from './e2e-environment.js'

type CaptureMode =
  | 'bidi'
  | 'classic'
  | 'controls'
  | 'edge'
  | 'hidpi'
  | 'odd-scale'
  | 'padded-mp4'
  | 'filtered-mp4'

const requestedMode = process.argv[2] ?? 'all'
const allModes: CaptureMode[] = [
  'bidi',
  'classic',
  'controls',
  'edge',
  'hidpi',
  'odd-scale',
  'padded-mp4',
  'filtered-mp4',
]
const modes = allModes.filter(
  (mode) =>
    requestedMode === 'all' ||
    mode === requestedMode ||
    (requestedMode === 'metadata' &&
      ['hidpi', 'odd-scale', 'padded-mp4', 'filtered-mp4'].includes(mode)),
)

if (modes.length === 0) {
  console.error(
    `[e2e:capture] Invalid mode "${requestedMode}". Use ${allModes.join(', ')}, metadata, or all.`,
  )
  process.exit(1)
}

const runMode = async (
  mode: CaptureMode,
  environment: E2eEnvironment,
): Promise<void> => {
  const wdioCliPath = path.resolve('node_modules/@wdio/cli/bin/wdio.js')
  const resultsDir = path.resolve('tests/results/capture', mode)
  console.log(`[e2e:capture] Starting ${mode}. Artifacts => ${resultsDir}`)
  const child = spawn(
    process.execPath,
    [wdioCliPath, 'run', 'tests/wdio.capture.conf.ts'],
    {
      env: environment.childEnvironment({
        WDIO_CAPTURE_MODE: mode,
        WDIO_RESULTS_DIR: resultsDir,
      }),
      stdio: 'inherit',
      windowsHide: true,
    },
  )
  await waitForChildProcess(child, (code) => {
    return `[e2e:capture] ${mode} run failed with code ${code}`
  })
  await assertManifestMediaDimensions(
    resultsDir,
    environment.ffmpegDetection.resolvedPath,
  )
}

const environment = await startE2eEnvironment()
try {
  for (const mode of modes) {
    await runMode(mode, environment)
  }
} finally {
  await environment.close()
}

console.log('[e2e:capture] Requested capture modes passed.')
