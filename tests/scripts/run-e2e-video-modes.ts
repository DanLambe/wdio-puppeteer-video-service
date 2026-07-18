import { spawn } from 'node:child_process'
import path from 'node:path'
import { assertAllureVideoAttachments } from '../utils/allure-assertions.js'
import { assertStaticVideoReport } from '../utils/video-artifact-assertions.js'
import { waitForChildProcess } from './child-process.js'
import { type E2eEnvironment, startE2eEnvironment } from './e2e-environment.js'

type VideoMode = 'multipart' | 'merge'

const expectedTestTitles = [
  'should record a simple navigation',
  'should handle iframe switching',
  'should handle a cross-origin iframe',
  'should handle multiple tabs and closing tabs',
  'should tolerate a browser target closing itself',
  'should handle alert, confirm, and prompt dialogs',
  'should handle viewport resizing',
  'should capture a deterministic animation',
  'should record a longer multi-step journey',
]

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
  environment: E2eEnvironment,
): Promise<void> => {
  const nodeCommand = process.execPath
  const wdioCliPath = path.resolve('node_modules/@wdio/cli/bin/wdio.js')
  const resultsDir = path.resolve('tests/results', mode)
  const mergeEnabled = mode === 'merge' ? '1' : '0'

  console.log(`[e2e:modes] Starting ${mode} run. Artifacts => ${resultsDir}`)

  const child = spawn(nodeCommand, [wdioCliPath, 'run', 'tests/wdio.conf.ts'], {
    stdio: 'inherit',
    windowsHide: true,
    env: environment.childEnvironment({
      WDIO_MERGE_SEGMENTS: mergeEnabled,
      WDIO_VIDEO_MODE: mode,
      WDIO_RESULTS_DIR: resultsDir,
    }),
  })

  await waitForChildProcess(child, (code) => {
    return `[e2e:modes] ${mode} run failed with code ${code}`
  })
  await assertStaticVideoReport({
    resultsDir,
    expectedTitles: expectedTestTitles,
    runLabel: mode,
  })
  await assertAllureVideoAttachments({
    resultsDir,
    expectedTitles: expectedTestTitles,
    runLabel: `${mode}-allure`,
  })

  console.log(`[e2e:modes] Completed ${mode} run.`)
}

const environment = await startE2eEnvironment()
try {
  for (const mode of modeOrder) {
    // Sequential runs preserve distinct artifact folders for each mode.
    await runWdio(mode, environment)
  }
} finally {
  await environment.close()
}

console.log('[e2e:modes] All requested runs completed successfully.')
