import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { startPipelineFixture } from './fixture.js'
import type { RunResult, WorkerMetrics } from './statistics.js'
import { summarizeSoak } from './statistics.js'
import { verifyPipelineMedia } from './verify-media.js'

const directory = process.env.PIPELINE_RUN_DIR as string
const soak = process.env.PIPELINE_SOAK === '1'
const specCount = soak ? 1 : 4
const expectedTests = soak ? 1 : specCount * 2
const result: RunResult = {
  schemaVersion: 1,
  label: path.basename(directory),
  pair: Number(process.env.PIPELINE_PAIR),
  variant: process.env.PIPELINE_VARIANT as RunResult['variant'],
  cpus: Number(process.env.PIPELINE_CPUS),
  workers: Number(process.env.PIPELINE_WORKERS),
  retain: process.env.PIPELINE_RETAIN as RunResult['retain'],
  soak,
  valid: false,
  suiteMs: 0,
  workerMetrics: [],
  artifactBytes: 0,
  media: [],
}
await fs.mkdir(path.join(directory, 'specs'), { recursive: true })
for (let i = 0; i < specCount; i += 1) {
  await fs.writeFile(
    path.join(directory, `specs/${i}.spec.ts`),
    `import { workload } from '/work/scripts/bench/pipeline/workload.ts'\nworkload(${i})\n`,
  )
}
const fixture = await startPipelineFixture()
try {
  const metadata = {
    kernel: os.release(),
    cpuModel: os.cpus()[0]?.model,
    dependencyLockSha256: createHash('sha256')
      .update(await fs.readFile('/work/package-lock.json'))
      .digest('hex'),
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    browser: spawnSync(process.env.CHROME_BINARY as string, ['--version'], {
      encoding: 'utf8',
    }).stdout.trim(),
    ffmpeg: spawnSync(process.env.FFMPEG_PATH as string, ['-version'], {
      encoding: 'utf8',
    }).stdout.split('\n')[0],
    cpuQuota: (await fs.readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim(),
    memoryLimit: (
      await fs.readFile('/sys/fs/cgroup/memory.max', 'utf8')
    ).trim(),
    versions: Object.fromEntries(
      await Promise.all(
        ['webdriverio', 'puppeteer-core', '@wdio/cli'].map(async (name) => [
          name,
          JSON.parse(
            await fs.readFile(
              `/work/node_modules/${name}/package.json`,
              'utf8',
            ),
          ).version,
        ]),
      ),
    ),
  }
  await fs.writeFile(
    path.join(directory, 'environment.json'),
    JSON.stringify(metadata, null, 2),
  )
  const log = createWriteStream(path.join(directory, 'wdio.log'))
  const start = performance.now()
  const child = spawn(
    process.execPath,
    [
      'node_modules/@wdio/cli/bin/wdio.js',
      'run',
      'scripts/bench/pipeline/wdio.conf.ts',
    ],
    {
      cwd: '/work',
      env: { ...process.env, PIPELINE_URL: fixture.url },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    result.suiteMs = performance.now() - start
    log.end()
    await finished(log)
    const files = await fs.readdir(directory)
    result.workerMetrics = await Promise.all(
      files
        .filter((file) => /^worker-.*\.json$/u.test(file))
        .map(
          async (file) =>
            JSON.parse(
              await fs.readFile(path.join(directory, file), 'utf8'),
            ) as WorkerMetrics,
        ),
    )
    assert.equal(code, 0, `WDIO exited ${code}; see wdio.log`)
    assert.equal(
      result.workerMetrics.length,
      specCount,
      'Missing worker telemetry',
    )
    assert.equal(
      result.workerMetrics.reduce((n, worker) => n + worker.passed, 0),
      expectedTests,
    )
    assert.equal(
      result.workerMetrics.reduce((n, worker) => n + worker.failed, 0),
      0,
    )
    for (const worker of result.workerMetrics) {
      assert.ok(worker.samples.length > 1 && worker.peakRssBytes > 0)
      assert.ok(Number.isFinite(worker.eventLoop.meanMs))
      assert.equal(
        worker.startupMs.length,
        result.variant === 'off' ? 0 : worker.passed,
      )
      assert.equal(worker.stopMs.length, worker.startupMs.length)
    }
    if (result.variant !== 'off') {
      Object.assign(
        result,
        await verifyPipelineMedia(
          path.join(directory, 'videos'),
          result.retain,
          expectedTests,
          Number(process.env.PIPELINE_DWELL_MS),
        ),
      )
    }
    if (soak) {
      const analysis = summarizeSoak(
        (result.workerMetrics[0] as WorkerMetrics).samples,
      )
      await fs.writeFile(
        path.join(directory, 'soak.json'),
        JSON.stringify(analysis, null, 2),
      )
      assert.equal(
        analysis.continuingGrowth,
        false,
        'Continuing worker memory growth requires investigation',
      )
    }
    result.valid = true
  } finally {
    log.end()
  }
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  await fixture.close()
  await fs.writeFile(
    path.join(directory, 'result.json'),
    JSON.stringify(result, null, 2),
  )
  console.log(
    JSON.stringify({
      label: result.label,
      valid: result.valid,
      suiteMs: result.suiteMs,
      error: result.error,
    }),
  )
}
