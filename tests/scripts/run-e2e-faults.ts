import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isVideoManifest } from '../../src/manifest.js'
import { waitForChildProcess } from './child-process.js'
import { startE2eEnvironment } from './e2e-environment.js'

const resultsDir = path.resolve('tests/results', 'faults')
const environment = await startE2eEnvironment()
try {
  console.log(`[e2e:faults] Starting run. Artifacts => ${resultsDir}`)
  const child = spawn(
    process.execPath,
    [
      path.resolve('node_modules/@wdio/cli/bin/wdio.js'),
      'run',
      'tests/wdio.faults.conf.ts',
    ],
    {
      stdio: 'inherit',
      windowsHide: true,
      env: environment.childEnvironment({ WDIO_RESULTS_DIR: resultsDir }),
    },
  )
  await waitForChildProcess(
    child,
    (code) => `[e2e:faults] Run failed with code ${code}`,
  )

  const manifest: unknown = JSON.parse(
    await readFile(path.join(resultsDir, 'manifest.json'), 'utf8'),
  )
  assert.ok(isVideoManifest(manifest))
  const entries = manifest.runs.flatMap((run) => run.entries)
  assert.equal(entries.length, 1, 'Expected one entry for the fault test')
  const [entry] = entries
  assert.ok(entry)
  // Red, blue, then red twice: the blue tab's second segment never started.
  assert.deepEqual(
    entry.capture.segments.map((segment) => [
      segment.tab?.ordinal,
      segment.tab?.reason,
    ]),
    [
      [1, 'start'],
      [2, 'command'],
      [1, 'command'],
      [1, 'command'],
    ],
  )
  assert.equal(
    entry.capture.decision,
    'failed',
    'A driven tab that was not recorded must leave the recording incomplete',
  )
  assert.equal(entry.capture.reason, 'capture-incomplete')
  console.log(
    `[e2e:faults] Completed: ${entry.capture.segments.length.toString()} segments, decision ${entry.capture.decision} (${entry.capture.reason})`,
  )
} finally {
  await environment.close()
}
