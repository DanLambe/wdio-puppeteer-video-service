import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'
import {
  prepareOutputDirectory,
  resolveBaseline,
  resolveExecutable,
  resolveImage,
} from './pipeline/inputs.js'
import { hashTree } from './pipeline/snapshot.js'
import {
  compareRuns,
  compareSwitching,
  completedPairs,
  qualificationPassed,
  type RunResult,
  SWITCHING_VARIANTS,
  VARIANTS,
} from './pipeline/statistics.js'

const { values } = parseArgs({
  options: {
    baseline: {
      type: 'string',
      default: 'd4bae0f72226340866c85179e1e1956036eec181',
    },
    image: { type: 'string', default: 'wdio-video-pipeline:local' },
    output: { type: 'string' },
    resume: { type: 'string' },
    smoke: { type: 'boolean', default: false },
    workload: { type: 'string', default: 'standard' },
  },
})
if (values.workload !== 'standard' && values.workload !== 'switching') {
  throw new Error('--workload must be standard or switching')
}
// Tab switching is measured against recording off: 1.0.0 cannot follow tabs.
const switching = values.workload === 'switching'
const variants = switching ? SWITCHING_VARIANTS : VARIANTS
const root = path.resolve(import.meta.dirname, '../..')
const outputRoot = path.join(root, 'tests', 'results', 'pipeline')
const directory = await prepareOutputDirectory(
  outputRoot,
  values.resume ??
    values.output ??
    path.join(outputRoot, new Date().toISOString().replaceAll(/[:.]/gu, '-')),
)
interface Environment {
  baselineSha: string
  imageId: string
  candidateSourceSha256: string
  harnessSha256: string
  availableCpus: number
  dockerVersion: string
  smoke: boolean
  workload?: 'standard' | 'switching'
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
if (previous && (previous.workload ?? 'standard') !== values.workload) {
  throw new Error(
    `Resume requires --workload ${previous.workload ?? 'standard'}`,
  )
}
// Resolved once: every call in a run uses the same binaries, recorded below.
const executables = {
  docker: resolveExecutable('docker'),
  git: resolveExecutable('git'),
  tar: resolveExecutable('tar'),
}
const execute = (
  command: keyof typeof executables,
  args: string[],
  timeout = 60_000,
  cwd = root,
) => {
  const run = spawnSync(executables[command], args, {
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
const baselineSha = resolveBaseline(
  execute,
  previous?.baselineSha ?? values.baseline,
)
const imageId = resolveImage(execute, previous?.imageId ?? values.image)
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
  await Promise.all(
    [
      'src',
      'scripts/bench/pipeline',
      'tests/utils',
      'tsconfig.json',
      'tsconfig.spec.json',
    ].map((relative) =>
      fs.cp(
        path.join(root, relative),
        path.join(snapshot, 'candidate', relative),
        { recursive: true },
      ),
    ),
  )
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
        executables,
        dockerVersion: execute('docker', [
          'version',
          '--format',
          '{{.Server.Version}}',
        ]),
        startedAt: new Date().toISOString(),
        smoke: values.smoke,
        workload: values.workload,
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
  results = completedPairs(JSON.parse(prior) as RunResult[], variants)
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
const hostUser =
  process.getuid && process.getgid
    ? ['--user', `${process.getuid()}:${process.getgid()}`, '-e', 'HOME=/tmp']
    : []
const dwellMs = (soak: boolean): number => {
  if (soak) {
    return 300_000
  }
  return switching ? 1_000 : 2_000
}
const run = async (
  cpus: number,
  workers: number,
  retain: 'all' | 'failures',
  pair: number,
  variant: RunResult['variant'],
  soak = false,
) => {
  const resumed = previous ? `-resumed-${resumeStamp}` : ''
  const label = `${cpus}cpu-${workers}worker-${retain}-${pair}-${variant}${soak ? '-soak' : ''}${resumed}`
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
    // The image runs as its unprivileged user. A POSIX host runs it as the
    // host user instead, who owns the results directory it writes to.
    ...hostUser,
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
      PIPELINE_DWELL_MS: dwellMs(soak),
      PIPELINE_SOAK: soak ? '1' : '0',
      PIPELINE_WORKLOAD: values.workload,
    }).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    imageId,
    'node',
    '--import',
    'tsx',
    '/work/scripts/bench/pipeline/run.ts',
  ]
  try {
    const { stdout } = await promisify(execFile)(executables.docker, args, {
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
    spawnSync(executables.docker, ['rm', '-f', name], {
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

let shapes = [
  [2, 2],
  [4, 4],
  [2, 4],
]
if (values.smoke) {
  shapes = [[2, 2]]
} else if (switching) {
  shapes = [
    [2, 2],
    [2, 4],
  ]
}
const retentions =
  values.smoke || switching
    ? (['all'] as const)
    : (['all', 'failures'] as const)
for (const [cpus, workers] of shapes) {
  for (const retain of retentions) {
    for (let pair = 1; pair <= (values.smoke ? 1 : 5); pair += 1) {
      // Alternate ordering to expose rather than systematically favor warm-cache effects.
      const order = pair % 2 ? [...variants] : [...variants].reverse()
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
const soakRequired = !values.smoke && !switching
if (soakRequired && !results.some((result) => result.soak)) {
  await run(2, 1, 'all', 1, 'candidate', true)
}
const comparisons = (switching ? compareSwitching : compareRuns)(
  results,
  values.smoke ? 1 : 5,
)
// An invalid baseline stays in results.json and is reported, but it cannot
// make a valid candidate fail or an invalid one pass.
const passed = qualificationPassed(results, comparisons, {
  workloads: shapes.length * retentions.length,
  soak: soakRequired,
})
process.off('SIGINT', cancel)
process.off('SIGTERM', cancel)
await fs.writeFile(
  path.join(directory, 'comparison.json'),
  JSON.stringify(
    {
      qualification: !values.smoke,
      workload: values.workload,
      passed,
      comparisons,
    },
    null,
    2,
  ),
)
console.log(JSON.stringify({ passed, comparisons }, null, 2))
if (!passed) {
  process.exitCode = 1
}
