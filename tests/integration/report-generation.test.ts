import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManifestEntryV1, VideoManifestV1 } from '../../src/manifest.js'
import {
  getReporterFragmentDirectory,
  writeReporterFragment,
} from '../../src/reporter/fragments.js'
import { generateVideoReportForRun } from '../../src/reporter/report-generator.js'
import type { ReporterFragmentV1 } from '../../src/reporter/types.js'

const runId = 'report-integration'
const timestamp = '2026-09-22T00:00:00.000Z'
let outputDir: string

const entry = (suite: string): ManifestEntryV1 => ({
  id: suite,
  runId,
  cid: '0-0',
  sessionHash: 'session',
  browser: { name: 'chrome', protocol: 'bidi+cdp' },
  framework: 'mocha',
  spec: 'report.ts',
  scope: 'test',
  attempt: 1,
  result: 'passed',
  test: { name: 'same title', fullName: `${suite} same title` },
  capture: {
    decision: 'recorded',
    segments: [{ path: `${suite}.webm`, mimeType: 'video/webm', size: 1 }],
  },
  processing: { timing: 'after-test', outcome: 'not-required' },
  timings: { startedAt: timestamp, completedAt: timestamp, durationMs: 0 },
})

const fragment = (): ReporterFragmentV1 => ({
  schemaVersion: 1,
  runId,
  cid: '0-0',
  specs: ['report.ts'],
  browser: { name: 'chrome' },
  reportFileName: 'video-report.html',
  startedAt: timestamp,
  completedAt: timestamp,
  outcomes: ['B', 'A'].map((suite) => ({
    uid: suite,
    runId,
    cid: '0-0',
    spec: 'report.ts',
    browser: { name: 'chrome' },
    test: { name: 'same title', fullName: `${suite} same title` },
    attempt: 1,
    retried: false,
    status: 'passed',
    durationMs: 0,
  })),
})

beforeEach(async () => {
  outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'report-integration-'))
  const manifest: VideoManifestV1 = {
    schemaVersion: 1,
    generatedAt: timestamp,
    runs: [
      {
        id: runId,
        startedAt: timestamp,
        completedAt: timestamp,
        exitCode: 0,
        tools: {
          service: '1.0.0-rc.5',
          node: 'v24.0.0',
          webdriverio: '9.29.1',
          puppeteer: '24.11.2',
        },
        entries: [entry('A'), entry('B')],
      },
    ],
  }
  await fs.writeFile(
    path.join(outputDir, 'manifest.json'),
    JSON.stringify(manifest),
  )
  // Media decoding is covered by the browser suite; this boundary checks
  // persisted identities, filesystem availability and generated HTML links.
  await fs.writeFile(path.join(outputDir, 'A.webm'), 'A')
  await fs.writeFile(path.join(outputDir, 'B.webm'), 'B')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(outputDir, { recursive: true, force: true })
})

describe('report generation from persisted artifacts', () => {
  it('shows ambiguous outcomes without video and keeps unassociated recordings visible', async () => {
    const value = fragment()
    value.outcomes = value.outcomes.slice(0, 1).map((outcome) => ({
      ...outcome,
      test: { name: 'same title' },
    }))
    await writeReporterFragment(outputDir, value)
    const result = await generateVideoReportForRun({ outputDir, runId })
    expect(result).toMatchObject({ itemCount: 3, diagnosticCount: 3 })
    const html = await fs.readFile(
      path.join(outputDir, 'video-report.html'),
      'utf8',
    )
    expect(html).toContain('ambiguous-test-outcome')
    const cards = [...html.matchAll(/<article\b[\s\S]*?<\/article>/gu)].map(
      (match) => match[0],
    )
    const unmatched = cards.filter((card) => card.includes('no manifest match'))
    expect(unmatched).toHaveLength(1)
    expect(unmatched[0]).not.toContain('<source')
    expect(html).toContain('src="./A.webm"')
    expect(html).toContain('src="./B.webm"')
  })

  it('joins reversed duplicate titles correctly and produces identical HTML on replay', async () => {
    const source = await writeReporterFragment(outputDir, fragment())
    const result = await generateVideoReportForRun({ outputDir, runId })
    expect(result).toMatchObject({ itemCount: 2, diagnosticCount: 0 })
    const reportPath = path.join(outputDir, 'video-report.html')
    const html = await fs.readFile(reportPath, 'utf8')
    const cards = [...html.matchAll(/<article\b[\s\S]*?<\/article>/gu)].map(
      (match) => match[0],
    )
    expect(cards).toHaveLength(2)
    for (const suite of ['A', 'B']) {
      const card = cards.find((value) => value.includes(`${suite} same title`))
      expect(card).toContain(`src="./${suite}.webm"`)
      expect(card).not.toContain(`src="./${suite === 'A' ? 'B' : 'A'}.webm"`)
    }
    await generateVideoReportForRun({ outputDir, runId })
    expect(await fs.readFile(reportPath, 'utf8')).toBe(html)
    expect(JSON.parse(await fs.readFile(source, 'utf8'))).toEqual(fragment())
  })

  // Replaces the seeded captures with "ADMIN" and "Admin", whose titles differ
  // only in case, recorded to media named "upper" and "title".
  const seedCaseDistinctCaptures = async (
    test: (title: string) => NonNullable<ManifestEntryV1['test']>,
  ): Promise<void> => {
    const manifestPath = path.join(outputDir, 'manifest.json')
    const manifest = JSON.parse(
      await fs.readFile(manifestPath, 'utf8'),
    ) as VideoManifestV1
    const run = manifest.runs[0]
    if (!run) {
      throw new Error('Expected the seeded run')
    }
    // Media names that differ by more than case, for case-insensitive disks.
    const media = { ADMIN: 'upper', Admin: 'title' } as const
    run.entries = (['ADMIN', 'Admin'] as const).map((title) => ({
      ...entry(title),
      test: test(title),
      capture: {
        decision: 'recorded',
        segments: [
          { path: `${media[title]}.webm`, mimeType: 'video/webm', size: 1 },
        ],
      },
    }))
    await fs.writeFile(manifestPath, JSON.stringify(manifest))
    await fs.writeFile(path.join(outputDir, 'upper.webm'), 'upper')
    await fs.writeFile(path.join(outputDir, 'title.webm'), 'title')
  }

  const readCards = async (): Promise<string[]> => {
    const html = await fs.readFile(
      path.join(outputDir, 'video-report.html'),
      'utf8',
    )
    return [...html.matchAll(/<article\b[\s\S]*?<\/article>/gu)].map(
      (match) => match[0],
    )
  }

  it('links each case-distinct full title to its own video', async () => {
    // Suites "ADMIN" and "Admin" differ only in case; the reporter lists them
    // in the opposite order to their captures.
    await seedCaseDistinctCaptures((suite) => ({
      name: 'same title',
      fullName: `${suite} same title`,
    }))
    const value = fragment()
    value.outcomes = ['Admin', 'ADMIN'].map((suite, index) => ({
      ...(value.outcomes[index] as ReporterFragmentV1['outcomes'][number]),
      uid: suite,
      test: { name: 'same title', fullName: `${suite} same title` },
    }))
    await writeReporterFragment(outputDir, value)

    const result = await generateVideoReportForRun({ outputDir, runId })

    expect(result).toMatchObject({ itemCount: 2, diagnosticCount: 0 })
    const cards = await readCards()
    for (const [suite, own, other] of [
      ['ADMIN', 'upper', 'title'],
      ['Admin', 'title', 'upper'],
    ] as const) {
      const card = cards.find((value) => value.includes(`${suite} same title`))
      expect(card).toContain(`src="./${own}.webm"`)
      expect(card).not.toContain(`src="./${other}.webm"`)
    }
  })

  it('diagnoses an extra top-level outcome instead of giving it the other spelling video', async () => {
    // Top-level tests are recorded with the title as both names. Two "ADMIN"
    // outcomes meet one "ADMIN" and one "Admin" capture.
    await seedCaseDistinctCaptures((title) => ({
      name: title,
      fullName: title,
    }))
    const value = fragment()
    value.outcomes = ['first', 'second'].map((uid, index) => ({
      ...(value.outcomes[index] as ReporterFragmentV1['outcomes'][number]),
      uid,
      test: { name: 'ADMIN', fullName: 'ADMIN' },
    }))
    await writeReporterFragment(outputDir, value)

    const result = await generateVideoReportForRun({ outputDir, runId })

    // Both outcomes, plus the "Admin" capture on a card of its own; the extra
    // outcome and the unclaimed capture are each diagnosed.
    expect(result).toMatchObject({ itemCount: 3, diagnosticCount: 2 })
    const cards = await readCards()
    const outcomeCards = cards.filter((card) => card.includes('<h2>ADMIN</h2>'))
    expect(outcomeCards).toHaveLength(2)
    expect(
      outcomeCards.filter((card) => card.includes('src="./upper.webm"')),
    ).toHaveLength(1)
    const unmatched = outcomeCards.filter((card) =>
      card.includes('no manifest match'),
    )
    expect(unmatched).toHaveLength(1)
    expect(unmatched[0]).not.toContain('<source')
    // The "Admin" video stays visible, only on its own unassociated card.
    const titleCards = cards.filter((card) =>
      card.includes('src="./title.webm"'),
    )
    expect(titleCards).toHaveLength(1)
    expect(titleCards[0]).toContain('<h2>Admin</h2>')
  })

  it('removes temporary report files after a real rename failure and preserves source fragments', async () => {
    const source = await writeReporterFragment(outputDir, fragment())
    const reportPath = path.join(outputDir, 'video-report.html')
    await fs.mkdir(reportPath)
    await fs.writeFile(path.join(reportPath, 'existing'), 'keep')
    await expect(
      generateVideoReportForRun({ outputDir, runId }),
    ).rejects.toThrow()
    expect(
      (await fs.readdir(outputDir)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([])
    expect(await fs.readFile(path.join(reportPath, 'existing'), 'utf8')).toBe(
      'keep',
    )
    expect(JSON.parse(await fs.readFile(source, 'utf8'))).toEqual(fragment())
  })

  it('removes failed fragment publications without damaging recoverable fragments', async () => {
    const source = await writeReporterFragment(outputDir, fragment())
    vi.spyOn(fs, 'rename').mockRejectedValue(new Error('publication denied'))
    await expect(writeReporterFragment(outputDir, fragment())).rejects.toThrow(
      'publication denied',
    )
    expect(
      await fs.readdir(getReporterFragmentDirectory(outputDir, runId)),
    ).toEqual([path.basename(source)])
    expect(JSON.parse(await fs.readFile(source, 'utf8'))).toEqual(fragment())
  })
})
