// Run with an optional report-model module path to compare another checkout.
// This isolates matching and sorting; browser and media I/O costs are excluded.
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ManifestEntryV1 } from '../../src/manifest.js'
import type { createReportModel as CreateReportModel } from '../../src/reporter/report-model.js'
import type { ReporterTestOutcome } from '../../src/reporter/types.js'

const modulePath = path.resolve(
  process.argv[2] ?? 'src/reporter/report-model.ts',
)
const { createReportModel } = (await import(
  pathToFileURL(modulePath).href
)) as {
  createReportModel: typeof CreateReportModel
}
const timestamp = '2026-09-22T00:00:00.000Z'
const results = []
for (const count of [1000, 5000, 10000]) {
  const entries = Array.from(
    { length: count },
    (_, index): ManifestEntryV1 => ({
      id: String(index),
      runId: 'r',
      cid: '0',
      sessionHash: 'h',
      browser: { name: 'chrome', protocol: 'bidi+cdp' },
      framework: 'mocha',
      spec: 'test.ts',
      scope: 'test',
      attempt: 1,
      result: 'passed',
      test: { name: `test ${index}`, fullName: `suite test ${index}` },
      capture: { decision: 'skipped', reason: String(index), segments: [] },
      processing: { timing: 'after-test', outcome: 'not-required' },
      timings: { startedAt: timestamp, completedAt: timestamp, durationMs: 0 },
    }),
  )
  const outcomes = entries.toReversed().map(
    (entry): ReporterTestOutcome => ({
      uid: entry.id,
      runId: 'r',
      cid: '0',
      spec: 'test.ts',
      browser: { name: 'chrome' },
      test: { name: `test ${entry.id}`, fullName: `suite test ${entry.id}` },
      attempt: 1,
      retried: false,
      status: 'passed',
      durationMs: 0,
    }),
  )
  const input: Parameters<typeof CreateReportModel>[0] = {
    outputDir: '.',
    runId: 'r',
    initialDiagnostics: [],
    run: {
      id: 'r',
      startedAt: timestamp,
      completedAt: timestamp,
      exitCode: 0,
      tools: {
        service: 'benchmark',
        node: process.version,
        webdriverio: 'fixture',
        puppeteer: 'fixture',
      },
      entries,
    },
    fragments: [
      {
        schemaVersion: 1,
        runId: 'r',
        cid: '0',
        specs: ['test.ts'],
        browser: { name: 'chrome' },
        reportFileName: 'report.html',
        startedAt: timestamp,
        completedAt: timestamp,
        outcomes,
      },
    ],
  }
  const samples = []
  let previous: Awaited<ReturnType<typeof CreateReportModel>> | undefined
  for (let pass = 0; pass < 3; pass += 1) {
    const start = performance.now()
    const model = await createReportModel(input)
    samples.push(performance.now() - start)
    assert.equal(model.items.length, count)
    assert.equal(model.diagnostics.length, 0)
    for (const item of model.items) {
      assert.equal(item.captureReason, item.id.slice(2, -2))
    }
    if (previous) {
      assert.deepEqual(model, previous)
    }
    previous = model
  }
  results.push({
    count,
    samplesMs: samples,
    medianMs: samples.toSorted((a, b) => a - b)[1],
  })
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      release: os.release(),
      cpu: os.cpus()[0]?.model,
      parallelism: os.availableParallelism(),
      module: modulePath,
      results,
    },
    null,
    2,
  ),
)
