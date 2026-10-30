import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isVideoManifest } from '../../src/manifest.js'
import { PARALLEL_MODE_UNSUPPORTED_REASON } from '../../src/service/parallel-mode.js'
import { waitForChildProcess } from './child-process.js'
import { type E2eEnvironment, startE2eEnvironment } from './e2e-environment.js'

type Framework = 'mocha' | 'cucumber'

interface ParallelRun {
  readonly framework: Framework
  readonly mode: 'contexts' | 'userContexts'
  readonly scope: 'test' | 'spec'
}

const testTitles: Record<Framework, readonly string[]> = {
  mocha: [
    'should run the first parallel test without recording',
    'should run the second parallel test without recording',
  ],
  cucumber: [
    'the first parallel scenario runs without recording',
    'the second parallel scenario runs without recording',
  ],
}

const requested = process.argv[2] || 'both'
const frameworks: Framework[] =
  requested === 'both'
    ? ['mocha', 'cucumber']
    : requested === 'mocha' || requested === 'cucumber'
      ? [requested]
      : []
if (frameworks.length === 0) {
  console.error(
    `[e2e:parallel] Invalid framework "${requested}". Use mocha, cucumber, or both.`,
  )
  process.exit(1)
}
// Both parallel modes for each framework, and spec-scope recording once.
const runs: ParallelRun[] = frameworks.flatMap((framework) => [
  { framework, mode: 'contexts', scope: 'test' },
  { framework, mode: 'userContexts', scope: 'test' },
  ...(framework === 'mocha'
    ? [{ framework, mode: 'contexts', scope: 'spec' } as const]
    : []),
])

const runParallel = async (
  { framework, mode, scope }: ParallelRun,
  environment: E2eEnvironment,
): Promise<void> => {
  const label = `${framework}-${mode}${scope === 'spec' ? '-spec' : ''}`
  const resultsDir = path.resolve('tests/results', `parallel-${label}`)
  console.log(
    `[e2e:parallel] Starting ${label} run. Artifacts => ${resultsDir}`,
  )
  const child = spawn(
    process.execPath,
    [
      path.resolve('node_modules/@wdio/cli/bin/wdio.js'),
      'run',
      'tests/wdio.parallel.conf.ts',
    ],
    {
      stdio: 'inherit',
      windowsHide: true,
      env: environment.childEnvironment({
        WDIO_PARALLEL_FRAMEWORK: framework,
        WDIO_PARALLEL_MODE: mode,
        WDIO_PARALLEL_SCOPE: scope,
        WDIO_RESULTS_DIR: resultsDir,
      }),
    },
  )
  await waitForChildProcess(
    child,
    (code) => `[e2e:parallel] ${label} run failed with code ${code}`,
  )

  // The tests run, but nothing is filmed, and the manifest says why.
  const media = (await readdir(resultsDir)).filter((file) =>
    /\.(mp4|webm)$/u.test(file),
  )
  assert.deepEqual(media, [], 'Expected no recordings in parallelMode')
  const manifest: unknown = JSON.parse(
    await readFile(path.join(resultsDir, 'manifest.json'), 'utf8'),
  )
  assert.ok(isVideoManifest(manifest))
  const entries = manifest.runs.flatMap((run) => run.entries)
  // Each test has its own entry, or the spec has one.
  assert.deepEqual(
    entries.map((entry) => entry.test?.name ?? entry.scope).sort(),
    scope === 'spec' ? ['spec'] : [...testTitles[framework]].sort(),
  )
  for (const entry of entries) {
    assert.equal(entry.capture.decision, 'skipped')
    assert.equal(entry.capture.reason, PARALLEL_MODE_UNSUPPORTED_REASON)
    assert.equal(entry.capture.segments.length, 0)
  }
  console.log(
    `[e2e:parallel] Completed ${label} run: ${entries.map((entry) => entry.test?.name ?? entry.scope).join('; ')}`,
  )
}

const environment = await startE2eEnvironment()
try {
  for (const run of runs) {
    await runParallel(run, environment)
  }
} finally {
  await environment.close()
}

console.log('[e2e:parallel] All requested runs completed successfully.')
