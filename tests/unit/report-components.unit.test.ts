import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ManifestEntryV1, ManifestRunV1 } from '../../src/manifest.js'
import { renderStaticVideoReport } from '../../src/reporter/html-renderer.js'
import {
  createReportModel,
  type ReportModel,
} from '../../src/reporter/report-model.js'
import type {
  ReporterFragmentV1,
  ReporterTestOutcome,
} from '../../src/reporter/types.js'

const tempDirs: string[] = []
const startedAt = '2026-07-18T00:00:00.000Z'
const completedAt = '2026-07-18T00:00:02.000Z'

const createTempDir = async (): Promise<string> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'report-components-'))
  tempDirs.push(tempDir)
  return tempDir
}

const createOutcome = (runId: string): ReporterTestOutcome => ({
  uid: 'outcome-1',
  runId,
  cid: '0-0',
  spec: 'tests/specs/report.ts',
  browser: { name: 'chrome' },
  test: { name: 'reported test' },
  attempt: 1,
  retried: false,
  status: 'passed',
  durationMs: 25,
})

const createFragment = (
  runId: string,
  completion: string,
  outcomes: ReporterTestOutcome[],
): ReporterFragmentV1 => ({
  schemaVersion: 1,
  runId,
  cid: '0-0',
  specs: ['tests/specs/report.ts'],
  browser: { name: 'chrome' },
  reportFileName: 'video-report.html',
  startedAt,
  completedAt: completion,
  outcomes,
})

const createEntryWithoutTest = (runId: string): ManifestEntryV1 => ({
  id: 'unmatched-entry',
  runId,
  cid: '0-0',
  sessionHash: 'hash',
  browser: { name: 'chrome', protocol: 'bidi+cdp' },
  framework: 'mocha',
  spec: 'tests/specs/report.ts',
  scope: 'test',
  attempt: 1,
  result: 'failed',
  capture: {
    decision: 'recorded',
    segments: [
      {
        path: 'missing.webm',
        mimeType: 'video/webm',
        size: 10,
      },
    ],
  },
  processing: { timing: 'after-test', outcome: 'not-required' },
  timings: { startedAt, completedAt, durationMs: 2000 },
})

const createRun = (
  runId: string,
  entries: ManifestEntryV1[],
): ManifestRunV1 => ({
  id: runId,
  startedAt,
  completedAt,
  exitCode: 0,
  tools: {
    service: '1.0.0-rc.1',
    node: 'v24.0.0',
    webdriverio: '9.29.1',
    puppeteer: '24.11.2',
  },
  entries,
})

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })),
  )
})

describe('report model and HTML renderer', () => {
  it('uses the latest fragment completion time without a manifest', async () => {
    const outputDir = await createTempDir()
    const runId = 'fragment-only-run'
    const model = await createReportModel({
      outputDir,
      runId,
      fragments: [
        createFragment(runId, '2026-07-18T00:00:01.000Z', [
          createOutcome(runId),
        ]),
        createFragment(runId, completedAt, []),
      ],
      run: undefined,
      initialDiagnostics: [],
    })

    expect(model.generatedAt).toBe(completedAt)
    expect(model.items).toEqual([
      expect.objectContaining({ browser: 'chrome', testName: 'reported test' }),
    ])
    expect(model.diagnostics).toEqual([])
  })

  it('reports unmatched entities and missing media in stable order', async () => {
    const outputDir = await createTempDir()
    const runId = 'unmatched-run'
    const model = await createReportModel({
      outputDir,
      runId,
      fragments: [createFragment(runId, completedAt, [createOutcome(runId)])],
      run: createRun(runId, [createEntryWithoutTest(runId)]),
      initialDiagnostics: [],
    })

    expect(model.items).toHaveLength(2)
    expect(model.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'missing-media-artifact',
      'unmatched-manifest-entry',
      'unmatched-test-outcome',
    ])
  })

  it('uses an epoch fallback and sorts equal diagnostic codes by message', async () => {
    const model = await createReportModel({
      outputDir: await createTempDir(),
      runId: 'empty-run',
      fragments: [],
      run: undefined,
      initialDiagnostics: [
        { code: 'invalid-manifest', message: 'z-last' },
        { code: 'invalid-manifest', message: 'a-first' },
      ],
    })

    expect(model.generatedAt).toBe(new Date(0).toISOString())
    expect(model.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'a-first',
      'z-last',
    ])
    expect(renderStaticVideoReport(model)).toContain(
      'No test outcomes were captured.',
    )
  })

  it('renders deterministic CSP, error, and large-media markup', () => {
    const model: ReportModel = {
      runId: 'stable-render',
      generatedAt: completedAt,
      diagnostics: [],
      items: [
        {
          id: 'failed-item',
          status: 'failed',
          spec: 'tests/specs/report.ts',
          browser: 'chrome 140',
          testName: 'failed test',
          attempt: 1,
          retried: false,
          durationMs: 25,
          errors: [{ message: 'boom', stack: 'trace-only' }],
          media: [
            {
              path: 'large.webm',
              href: './large.webm',
              mimeType: 'video/webm',
              size: 2 * 1024 * 1024,
              available: true,
            },
          ],
        },
      ],
    }

    const first = renderStaticVideoReport(model)
    expect(renderStaticVideoReport(model)).toBe(first)
    expect(first).toContain('boom\ntrace-only')
    expect(first).toContain('2.0 MiB')

    // The policy has to hash what the report actually ships, so recompute both
    // digests from the emitted blocks: any drift between the constants and the
    // markup, or any later edit to either block, stops them from matching and
    // the browser would refuse to run the report.
    const script = /<script>([\s\S]*?)<\/script>/u.exec(first)?.[1]
    const styles = /<style>([\s\S]*?)<\/style>/u.exec(first)?.[1]
    expect(script).toBeDefined()
    expect(styles).toBeDefined()
    expect(first).toContain(`script-src '${digestOf(script as string)}'`)
    expect(first).toContain(`style-src '${digestOf(styles as string)}'`)
    // A nonce that is reproducible is not a nonce, and `frame-ancestors` is
    // ignored in a meta policy, so neither belongs in a static report.
    expect(first).not.toContain('nonce')
    expect(first).not.toContain('frame-ancestors')
  })
})

const digestOf = (content: string): string =>
  `sha256-${createHash('sha256').update(content, 'utf8').digest('base64')}`
