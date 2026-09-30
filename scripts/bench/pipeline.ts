import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'
import {
  compareRuns,
  completedPairs,
  qualificationPassed,
  type RunResult,
} from './pipeline/statistics.js'

const { values } = parseArgs({
  options: {
    baseline: {
      type: 'string',
      default: '0b61d4f8a79be92dd4ffce315d4d2cc9e0a8a798',
    },
    image: { type: 'string', default: 'wdio-video-pipeline:local' },
    output: { type: 'string' },
    resume: { type: 'string' },
    smoke: { type: 'boolean', default: false },
  },
})
const root = path.resolve(import.meta.dirname, '../..')
const directory = path.resolve(
  values.resume ??
    values.output ??
    path.join(
      root,
      'tests/results/pipeline',
      new Date().toISOString().replaceAll(/[:.]/gu, '-'),
    ),
)
await fs.mkdir(directory, { recursive: true })
interface Environment {
  baselineSha: string
  imageId: string
  candidateSourceSha256: string
  harnessSha256: string
  availableCpus: number
  dockerVersion: string
  smoke: boolean
}
const previous: Environment | undefined = values.resume
  ? (JSON.parse(
      await fs.readFile(path.join(directory, 'environment.json'), 'utf8'),
    ) as Environment)
  : undefined
if (previous?.smoke || (values.resume && (values.smoke || values.output))) {
  throw new Error(
    'Resume requires an interrupted full run and cannot be combined with smoke or output',
  )
}
const execute = (
  command: string,
  args: string[],
  timeout = 60_000,
  cwd = root,
) => {
  const run = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (run.error || run.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${run.error?.message ?? run.stderr}`,
    )
  }
  return run.stdout.trim()
}
const baselineSha = execute('git', [
  'rev-parse',
  '--verify',
  `${previous?.baselineSha ?? values.baseline}^{commit}`,
])
const imageId = execute('docker', [
  'inspect',
  '--format',
  '{{.Id}}',
  previous?.imageId ?? values.image,
])
const availableCpus = Number(
  execute('docker', ['info', '--format', '{{.NCPU}}']),
)
if (availableCpus < 4 && !values.smoke) {
  throw new Error(
    'The full benchmark needs a Docker host with at least four CPUs',
  )
}
// Freeze source and harness before the first pair; later edits cannot change a run.
const snapshot = path.join(directory, 'snapshot')
if (!previous) {
  await fs.mkdir(snapshot)
  await fs.mkdir(path.join(snapshot, 'baseline'))
  execute('git', [
    'archive',
    '--format=tar',
    `--output=${path.join(snapshot, 'baseline.tar')}`,
    baselineSha,
    'src',
  ])
  // Relative paths: GNU tar, first on PATH in Git Bash and MSYS shells, reads
  // an absolute Windows path's drive letter as a remote host.
  execute('tar', ['-xf', 'baseline.tar', '-C', 'baseline'], undefined, snapshot)
  for (const relative of [
    'src',
    'scripts/bench/pipeline',
    'tests/utils',
    'tsconfig.json',
    'tsconfig.spec.json',
  ]) {
    await fs.cp(
      path.join(root, relative),
      path.join(snapshot, 'candidate', relative),
      { recursive: true },
    )
  }
}
const hashTree = async (base: string): Promise<string> => {
  const files = (
    await fs.readdir(base, { recursive: true, withFileTypes: true })
  )
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort()
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(path.relative(base, file).replaceAll('\\', '/'))
    hash.update(await fs.readFile(file))
  }
  return hash.digest('hex')
}
if (!previous) {
  await fs.writeFile(
    path.join(directory, 'environment.json'),
    JSON.stringify(
      {
        baselineSha,
        candidateHead: execute('git', ['rev-parse', 'HEAD']),
        candidateSourceSha256: await hashTree(
          path.join(snapshot, 'candidate/src'),
        ),
        harnessSha256: await hashTree(
          path.join(snapshot, 'candidate/scripts/bench/pipeline'),
        ),
        dependencyLockSha256: createHash('sha256')
          .update(await fs.readFile(path.join(root, 'package-lock.json')))
          .digest('hex'),
        imageId,
        availableCpus,
        dockerVersion: execute('docker', [
          'version',
          '--format',
          '{{.Server.Version}}',
        ]),
        startedAt: new Date().toISOString(),
        smoke: values.smoke,
      },
      null,
      2,
    ),
  )
}

const resumeStamp = new Date().toISOString().replaceAll(/[:.]/gu, '-')
let results: RunResult[] = []
if (previous) {
  if (
    imageId !== previous.imageId ||
    availableCpus !== previous.availableCpus ||
    execute('docker', ['version', '--format', '{{.Server.Version}}']) !==
      previous.dockerVersion ||
    (await hashTree(path.join(snapshot, 'candidate/src'))) !==
      previous.candidateSourceSha256 ||
    (await hashTree(
      path.join(snapshot, 'candidate/scripts/bench/pipeline'),
    )) !== previous.harnessSha256
  ) {
    throw new Error(
      'The saved environment or source snapshot changed; start a fresh comparison',
    )
  }
  const prior = await fs.readFile(path.join(directory, 'results.json'), 'utf8')
  results = completedPairs(JSON.parse(prior) as RunResult[])
  await fs.writeFile(
    path.join(directory, `before-resume-${resumeStamp}.json`),
    prior,
    { flag: 'wx' },
  )
  console.log(
    `[pipeline] Resuming ${directory}; retaining ${results.length} observations from complete pairs`,
  )
}
const interruption = new AbortController()
const cancel = () =>
  interruption.abort(new Error('Pipeline measurement interrupted'))
process.once('SIGINT', cancel)
process.once('SIGTERM', cancel)
const run = async (
  cpus: number,
  workers: number,
  retain: 'all' | 'failures',
  pair: number,
  variant: RunResult['variant'],
  soak = false,
) => {
  const label = `${cpus}cpu-${workers}worker-${retain}-${pair}-${variant}${soak ? '-soak' : ''}${previous ? `-resumed-${resumeStamp}` : ''}`
  const name = `wdio-pipeline-${process.pid}-${label}`
  const source = path.join(
    snapshot,
    variant === 'baseline' ? 'baseline' : 'candidate',
    'src',
  )
  const mount = (from: string, to: string) => [
    '--mount',
    `type=bind,source=${from},target=${to},readonly`,
  ]
  console.log(`[pipeline] ${label}`)
  const args = [
    'run',
    '--rm',
    '--name',
    name,
    `--cpus=${cpus}`,
    '--memory=7g',
    '--memory-swap=7g',
    '--shm-size=2g',
    ...mount(source, '/work/src'),
    ...mount(
      path.join(snapshot, 'candidate/scripts/bench/pipeline'),
      '/work/scripts/bench/pipeline',
    ),
    ...mount(path.join(snapshot, 'candidate/tests/utils'), '/work/tests/utils'),
    ...mount(path.join(snapshot, 'candidate'), '/validation'),
    ...mount(
      path.join(snapshot, 'candidate/tsconfig.json'),
      '/work/tsconfig.json',
    ),
    ...mount(
      path.join(snapshot, 'candidate/tsconfig.spec.json'),
      '/work/tsconfig.spec.json',
    ),
    '--mount',
    `type=bind,source=${directory},target=/results`,
    ...Object.entries({
      PIPELINE_RUN_DIR: `/results/${label}`,
      PIPELINE_VARIANT: variant,
      PIPELINE_PAIR: pair,
      PIPELINE_CPUS: cpus,
      PIPELINE_WORKERS: workers,
      PIPELINE_RETAIN: retain,
      PIPELINE_DWELL_MS: soak ? 300_000 : 2_000,
      PIPELINE_SOAK: soak ? '1' : '0',
    }).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    imageId,
    'node',
    '--import',
    'tsx',
    '/work/scripts/bench/pipeline/run.ts',
  ]
  try {
    const { stdout } = await promisify(execFile)('docker', args, {
      cwd: root,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      signal: AbortSignal.any([
        interruption.signal,
        AbortSignal.timeout(soak ? 12 * 60_000 : 4 * 60_000),
      ]),
    })
    console.log(stdout.trim())
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
  } finally {
    // Removing this owned container also terminates any remaining browser/encoder descendants.
    spawnSync('docker', ['rm', '-f', name], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 30_000,
    })
  }
  if (
    execute('docker', [
      'ps',
      '-a',
      '--filter',
      `name=^/${name}$`,
      '--format',
      '{{.ID}}',
    ])
  ) {
    throw new Error(
      `Owned container ${name} survived cleanup; stopping measurements`,
    )
  }
  interruption.signal.throwIfAborted()
  try {
    results.push(
      JSON.parse(
        await fs.readFile(path.join(directory, label, 'result.json'), 'utf8'),
      ) as RunResult,
    )
  } catch {
    results.push({
      schemaVersion: 1,
      label,
      pair,
      variant,
      cpus,
      workers,
      retain,
      soak,
      valid: false,
      error: 'Container produced no result.json',
      suiteMs: 0,
      workerMetrics: [],
      artifactBytes: 0,
      media: [],
    })
  }
  await fs.writeFile(
    path.join(directory, 'results.json'),
    JSON.stringify(results, null, 2),
  )
}

const shapes = values.smoke
  ? [[2, 2]]
  : [
      [2, 2],
      [4, 4],
      [2, 4],
    ]
const retentions = values.smoke
  ? (['all'] as const)
  : (['all', 'failures'] as const)
for (const [cpus, workers] of shapes) {
  for (const retain of retentions) {
    for (let pair = 1; pair <= (values.smoke ? 1 : 5); pair += 1) {
      // Alternate ordering to expose rather than systematically favor warm-cache effects.
      const order: RunResult['variant'][] =
        pair % 2
          ? ['off', 'baseline', 'candidate']
          : ['candidate', 'baseline', 'off']
      for (const variant of order) {
        if (
          results.some(
            (result) =>
              !result.soak &&
              result.cpus === cpus &&
              result.workers === workers &&
              result.retain === retain &&
              result.pair === pair &&
              result.variant === variant,
          )
        ) {
          continue
        }
        await run(cpus as number, workers as number, retain, pair, variant)
      }
    }
  }
}
if (!values.smoke && !results.some((result) => result.soak)) {
  await run(2, 1, 'all', 1, 'candidate', true)
}
const comparisons = compareRuns(results, values.smoke ? 1 : 5)
// An invalid baseline stays in results.json and is reported, but it cannot
// make a valid candidate fail or an invalid one pass.
const passed = qualificationPassed(results, comparisons, {
  workloads: shapes.length * retentions.length,
  soak: !values.smoke,
})
process.off('SIGINT', cancel)
process.off('SIGTERM', cancel)
await fs.writeFile(
  path.join(directory, 'comparison.json'),
  JSON.stringify(
    { qualification: !values.smoke, passed, comparisons },
    null,
    2,
  ),
)
console.log(JSON.stringify({ passed, comparisons }, null, 2))
if (!passed) {
  process.exitCode = 1
}
