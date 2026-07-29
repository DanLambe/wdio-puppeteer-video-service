import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import type { RunnerStats, TestStats } from '@wdio/reporter'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WdioPuppeteerVideoLauncher from '../../src/launcher.js'
import type {
  ManifestEntryV1,
  ManifestRunV1,
  VideoManifestV1,
} from '../../src/manifest.js'
import {
  getReporterFragmentDirectory,
  normalizeReportFileName,
  readReporterFragments,
  writeReporterFragment,
} from '../../src/reporter/fragments.js'
import { generateVideoReportForRun } from '../../src/reporter/report-generator.js'
import { createReportModel } from '../../src/reporter/report-model.js'
import type {
  ReporterBrowserIdentity,
  ReporterFragmentV1,
  ReporterTestOutcome,
  ReporterTestStatus,
} from '../../src/reporter/types.js'
import WdioPuppeteerVideoReporter from '../../src/reporter.js'
import {
  assignManifestRunContext,
  assignManifestWorkerContext,
  createManifestRunContext,
  readManifestRunContext,
} from '../../src/service/manifest-runtime.js'

const tempDirs: string[] = []
const browserIdentity: ReporterBrowserIdentity = {
  name: 'chrome',
  version: '140.0.0',
}

const createTempDir = async (): Promise<string> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-reporter-'))
  tempDirs.push(tempDir)
  return tempDir
}

const createOutcome = (options: {
  runId: string
  cid: string
  spec: string
  name: string
  fullName?: string
  containerName?: string
  attempt?: number
  status?: ReporterTestStatus
  retried?: boolean
  error?: string
}): ReporterTestOutcome => ({
  uid: `${options.cid}-${options.name}-${(options.attempt ?? 1).toString()}`,
  runId: options.runId,
  cid: options.cid,
  spec: options.spec,
  browser: browserIdentity,
  test: {
    name: options.name,
    ...(options.fullName ? { fullName: options.fullName } : {}),
    ...(options.containerName ? { containerName: options.containerName } : {}),
  },
  attempt: options.attempt ?? 1,
  retried: options.retried ?? false,
  status: options.status ?? 'passed',
  durationMs: 25,
  ...(options.error
    ? { errors: [{ message: options.error, stack: options.error }] }
    : {}),
})

const createFragment = (
  runId: string,
  cid: string,
  specs: string[],
  outcomes: ReporterTestOutcome[],
): ReporterFragmentV1 => ({
  schemaVersion: 1,
  runId,
  cid,
  specs,
  browser: browserIdentity,
  reportFileName: 'video-report.html',
  startedAt: '2026-07-18T00:00:00.000Z',
  completedAt: '2026-07-18T00:00:01.000Z',
  outcomes,
})

const createEntry = (options: {
  id: string
  runId: string
  cid: string
  spec: string
  name?: string
  fullName?: string
  attempt?: number
  result?: 'passed' | 'failed' | 'skipped' | 'unknown'
  scope?: 'test' | 'spec'
  artifactPath?: string
  captureDecision?: 'recorded' | 'discarded' | 'skipped' | 'failed'
}): ManifestEntryV1 => ({
  id: options.id,
  runId: options.runId,
  cid: options.cid,
  sessionHash: `hash-${options.cid}`,
  browser: { ...browserIdentity, protocol: 'bidi+cdp' },
  framework: 'mocha',
  spec: options.spec,
  ...(options.scope === 'spec'
    ? {}
    : {
        test: {
          name: options.name ?? 'unknown test',
          ...(options.fullName ? { fullName: options.fullName } : {}),
        },
      }),
  scope: options.scope ?? 'test',
  attempt: options.attempt ?? 1,
  result: options.result ?? 'passed',
  capture: {
    decision:
      options.captureDecision ??
      (options.artifactPath ? 'recorded' : 'skipped'),
    segments: options.artifactPath
      ? [
          {
            path: options.artifactPath,
            mimeType: 'video/webm',
            size: 5,
            width: 1280,
            height: 720,
          },
        ]
      : [],
    ...(options.artifactPath ? {} : { reason: 'not-retained' }),
  },
  processing: {
    timing: 'after-test',
    outcome: options.artifactPath ? 'not-required' : 'skipped',
  },
  timings: {
    startedAt: '2026-07-18T00:00:00.000Z',
    completedAt: '2026-07-18T00:00:01.000Z',
    durationMs: 1000,
  },
})

const createManifest = (
  runId: string,
  entries: ManifestEntryV1[],
): VideoManifestV1 => {
  const run: ManifestRunV1 = {
    id: runId,
    startedAt: '2026-07-18T00:00:00.000Z',
    completedAt: '2026-07-18T00:00:02.000Z',
    exitCode: 0,
    tools: {
      service: '0.8.1',
      node: 'v24.0.0',
      webdriverio: '9.29.1',
      puppeteer: '25.3.0',
    },
    entries,
  }
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-18T00:00:03.000Z',
    runs: [run],
  }
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })),
  )
})

describe('WdioPuppeteerVideoReporter', () => {
  it('uses stderr as the default diagnostic stream', async () => {
    const outputDir = await createTempDir()
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const reporter = new WdioPuppeteerVideoReporter({ outputDir })
      reporter.write('reporter diagnostic')
      expect(stderr).toHaveBeenCalledWith('reporter diagnostic')
    } finally {
      stderr.mockRestore()
    }
  })

  it('keeps event hooks safe before runner initialization', () => {
    const reporter = new WdioPuppeteerVideoReporter({
      writeStream: { write: () => true },
    })
    const test = {
      uid: 'early-test',
      title: 'early test',
      state: 'passed',
      duration: 1,
    } as unknown as TestStats
    const runner = {} as RunnerStats

    expect(reporter.onTestPass(test)).toBeUndefined()
    expect(reporter.onTestFail(test)).toBeUndefined()
    expect(reporter.onTestSkip(test)).toBeUndefined()
    expect(reporter.onTestPending(test)).toBeUndefined()
    expect(reporter.onTestEnd(test)).toBeUndefined()
    expect(reporter.onRunnerEnd(runner)).toBeUndefined()
    expect(reporter.isSynchronised).toBe(true)
  })

  it('reports asynchronous fragment write failures without blocking WDIO', async () => {
    const tempDir = await createTempDir()
    const blockedOutput = path.join(tempDir, 'blocked')
    const write = vi.fn(() => true)
    const reporter = new WdioPuppeteerVideoReporter({
      outputDir: blockedOutput,
      writeStream: { write },
    })
    const runner = {
      cid: 'failed-flush',
      config: { specFileRetries: -1 },
      specs: [path.resolve('tests/specs/failed-flush.ts')],
      capabilities: { browserName: 'chrome', version: '139.0.0' },
      start: new Date('2026-07-18T00:00:00.000Z'),
    } as unknown as RunnerStats
    reporter.onRunnerStart(runner)
    await fs.rm(blockedOutput, { recursive: true, force: true })
    await fs.writeFile(blockedOutput, 'not-a-directory', 'utf8')
    reporter.onTestPass({
      uid: 'passed-test',
      title: 'passes',
      state: 'passed',
      duration: 1.9,
    } as unknown as TestStats)
    reporter.onRunnerEnd(runner)

    await vi.waitFor(() => expect(reporter.isSynchronised).toBe(true))
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('Failed to flush reporter fragment'),
    )
  })

  it('captures retries, final outcomes, and skipped tests before one final flush', async () => {
    const outputDir = await createTempDir()
    const context = await createManifestRunContext(outputDir)
    const config: Record<string, unknown> = { framework: 'mocha' }
    assignManifestRunContext(config, context)
    assignManifestWorkerContext(config, '0-0', { specFileRetryAttempt: 0 })
    const reporter = new WdioPuppeteerVideoReporter({ outputDir })
    const specPath = path.resolve('tests/specs/reporter.spec.ts')
    const runner = {
      cid: '0-0',
      config,
      specs: [pathToFileURL(specPath).href],
      capabilities: { browserName: 'chrome', browserVersion: '140.0.0' },
      start: new Date('2026-07-18T00:00:00.000Z'),
      retry: 0,
    } as unknown as RunnerStats
    reporter.onRunnerStart(runner)

    const firstAttempt = {
      uid: 'test-1',
      title: 'records a retry',
      fullTitle: 'reporter records a retry',
      retries: 0,
      state: 'failed',
      duration: 10,
      errors: [new Error('first attempt failed')],
    } as unknown as TestStats
    const finalAttempt = {
      ...firstAttempt,
      retries: 1,
      state: 'passed',
      duration: 12,
      errors: undefined,
    } as unknown as TestStats
    const skipped = {
      uid: 'test-2',
      title: 'is skipped',
      fullTitle: 'reporter is skipped',
      retries: 0,
      state: 'skipped',
      duration: 0,
      pendingReason: 'not supported here',
    } as unknown as TestStats

    expect(reporter.onTestRetry(firstAttempt)).toBeUndefined()
    expect(reporter.onTestEnd(finalAttempt)).toBeUndefined()
    reporter.onTestSkip(skipped)
    reporter.onTestEnd(skipped)
    expect(reporter.onRunnerEnd(runner)).toBeUndefined()
    expect(reporter.isSynchronised).toBe(false)
    await vi.waitFor(() => expect(reporter.isSynchronised).toBe(true))

    const { fragments, invalidFiles } = await readReporterFragments(
      outputDir,
      context.runId,
    )
    expect(invalidFiles).toEqual([])
    expect(fragments).toHaveLength(1)
    expect(fragments[0]?.specs).toEqual(['tests/specs/reporter.spec.ts'])
    expect(fragments[0]?.outcomes).toHaveLength(3)
    expect(
      fragments[0]?.outcomes.map((outcome) => ({
        status: outcome.status,
        attempt: outcome.attempt,
        retried: outcome.retried,
      })),
    ).toEqual([
      { status: 'failed', attempt: 1, retried: true },
      { status: 'passed', attempt: 2, retried: true },
      { status: 'skipped', attempt: 1, retried: false },
    ])
  })

  it('rejects report paths so fragments cannot write outside outputDir', () => {
    expect(normalizeReportFileName(undefined)).toBe('video-report.html')
    expect(normalizeReportFileName('custom.html')).toBe('custom.html')
    expect(() => normalizeReportFileName('../report.html')).toThrow(
      'without directory segments',
    )
    expect(() => normalizeReportFileName('report.json')).toThrow(
      'non-empty .html filename',
    )
    for (const invalidName of [
      '',
      ' report.html',
      'report?.html',
      'bad\u0000.html',
    ]) {
      expect(() => normalizeReportFileName(invalidName)).toThrow(TypeError)
    }
  })

  it('uses worker retry context and remains idempotent with sparse runner metadata', async () => {
    const outputDir = await createTempDir()
    const context = await createManifestRunContext(outputDir)
    const config: Record<string, unknown> = { specFileRetries: 1 }
    assignManifestRunContext(config, context)
    assignManifestWorkerContext(config, '1-0', { specFileRetryAttempt: 1 })
    const reporter = new WdioPuppeteerVideoReporter({
      outputDir,
      writeStream: { write: () => true },
    })
    const runner = {
      cid: '1-0',
      config,
      specs: [],
      capabilities: {},
      start: new Date('2026-07-18T00:00:00.000Z'),
    } as unknown as RunnerStats
    reporter.onRunnerStart(runner)
    reporter.currentSuites.push({
      type: 'scenario',
      title: 'scenario from suite',
    } as never)
    const sparseTest = {
      uid: 'sparse-test',
      title: '',
      fullTitle: '',
      parent: '',
      state: 'unexpected',
      duration: -10,
      error: { message: '', toString: () => 'fallback error' },
    } as unknown as TestStats
    reporter.onTestFail(sparseTest)
    reporter.onTestPending(sparseTest)
    reporter.onRunnerEnd(runner)
    reporter.onRunnerEnd(runner)
    await vi.waitFor(() => expect(reporter.isSynchronised).toBe(true))

    const { fragments } = await readReporterFragments(outputDir, context.runId)
    expect(fragments[0]?.outcomes).toEqual([
      expect.objectContaining({
        attempt: 2,
        retried: true,
        status: 'unknown',
        spec: 'unknown-spec',
        browser: { name: 'unknown' },
        test: expect.objectContaining({
          name: 'unknown test',
          containerName: 'scenario from suite',
        }),
        durationMs: 0,
      }),
    ])
  })

  it('does not classify a first-attempt pass as retried merely because retries are enabled', async () => {
    const outputDir = await createTempDir()
    const context = await createManifestRunContext(outputDir)
    const config: Record<string, unknown> = { specFileRetries: 1 }
    assignManifestRunContext(config, context)
    assignManifestWorkerContext(config, '0-0', { specFileRetryAttempt: 0 })
    const reporter = new WdioPuppeteerVideoReporter({ outputDir })
    const runner = {
      cid: '0-0',
      config,
      specs: [path.resolve('tests/specs/first-attempt.ts')],
      capabilities: { browserName: 'chrome' },
      start: new Date('2026-07-18T00:00:00.000Z'),
    } as unknown as RunnerStats
    reporter.onRunnerStart(runner)
    reporter.onTestPass({
      uid: 'first-attempt-pass',
      title: 'passes immediately',
      state: 'passed',
      duration: 1,
      retries: 0,
    } as unknown as TestStats)
    reporter.onRunnerEnd(runner)
    await vi.waitFor(() => expect(reporter.isSynchronised).toBe(true))

    const { fragments } = await readReporterFragments(outputDir, context.runId)
    expect(fragments[0]?.outcomes[0]).toMatchObject({
      attempt: 1,
      retried: false,
    })
  })
})

describe('static report generation', () => {
  it('does nothing when no reporter fragments exist', async () => {
    const outputDir = await createTempDir()
    await expect(
      generateVideoReportForRun({ outputDir, runId: 'missing-run' }),
    ).resolves.toBeUndefined()
    await expect(
      readReporterFragments(outputDir, 'missing-run'),
    ).resolves.toEqual({ fragments: [], invalidFiles: [] })
  })

  it('aggregates parallel fragments, joins retries, and emits secure relative media links', async () => {
    const outputDir = await createTempDir()
    const runId = 'parallel-run'
    const firstSpec = 'tests/specs/first.spec.ts'
    const secondSpec = 'tests/specs/second.spec.ts'
    const hostileName = '</script><img src=x onerror=alert(1)>'
    await fs.mkdir(path.join(outputDir, 'media'), { recursive: true })
    await fs.writeFile(
      path.join(outputDir, 'media', 'failure clip.webm'),
      'video',
    )
    await fs.writeFile(path.join(outputDir, 'media', 'retry.webm'), 'video')
    const firstOutcomes = [
      createOutcome({
        runId,
        cid: '0-0',
        spec: firstSpec,
        name: hostileName,
        fullName: `suite ${hostileName}`,
        status: 'failed',
        retried: true,
        error: '<script>steal()</script>',
      }),
      createOutcome({
        runId,
        cid: '0-0',
        spec: firstSpec,
        name: hostileName,
        fullName: `suite ${hostileName}`,
        status: 'passed',
        attempt: 2,
        retried: true,
      }),
    ]
    const secondOutcomes = [
      createOutcome({
        runId,
        cid: '0-1',
        spec: secondSpec,
        name: 'skipped without video',
        status: 'skipped',
      }),
    ]
    await Promise.all([
      writeReporterFragment(
        outputDir,
        createFragment(runId, '0-0', [firstSpec], firstOutcomes),
      ),
      writeReporterFragment(
        outputDir,
        createFragment(runId, '0-1', [secondSpec], secondOutcomes),
      ),
    ])
    const manifest = createManifest(runId, [
      createEntry({
        id: 'entry-1',
        runId,
        cid: '0-0',
        spec: firstSpec,
        name: hostileName,
        fullName: `suite ${hostileName}`,
        result: 'failed',
        artifactPath: 'media/failure clip.webm',
      }),
      createEntry({
        id: 'entry-2',
        runId,
        cid: '0-0',
        spec: firstSpec,
        name: hostileName,
        fullName: `suite ${hostileName}`,
        attempt: 2,
        artifactPath: 'media/retry.webm',
      }),
      createEntry({
        id: 'entry-3',
        runId,
        cid: '0-1',
        spec: secondSpec,
        name: 'skipped without video',
        result: 'skipped',
        captureDecision: 'skipped',
      }),
    ])

    const generated = await generateVideoReportForRun({
      outputDir,
      runId,
      manifest,
    })
    expect(generated).toMatchObject({ itemCount: 3, diagnosticCount: 0 })
    const html = await fs.readFile(
      path.join(outputDir, 'video-report.html'),
      'utf8',
    )
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("default-src 'none'")
    expect(html).not.toContain("'unsafe-inline'")
    expect(html).toContain('./media/failure%20clip.webm')
    expect(html).toContain('video/webm')
    expect(html).toContain('status-filter')
    expect(html).toContain('spec-filter')
    expect(html).toContain('browser-filter')
    expect(html).toContain('retry-filter')
    expect(html).toContain('&lt;/script&gt;&lt;img')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toMatch(/https?:\/\//u)
    expect(await fs.readdir(path.join(outputDir, 'media'))).toEqual([
      'failure clip.webm',
      'retry.webm',
    ])
    assertOfflineFilterScript(html)
  })

  it('renders byte-identical output for unchanged inputs and keeps corrupt media linkable', async () => {
    const outputDir = await createTempDir()
    const runId = 'deterministic-run'
    const spec = 'tests/specs/deterministic.ts'
    const mediaPath = 'corrupt-but-linkable.webm'
    await fs.writeFile(path.join(outputDir, mediaPath), 'not-valid-media')
    await writeReporterFragment(
      outputDir,
      createFragment(
        runId,
        '0-0',
        [spec],
        [createOutcome({ runId, cid: '0-0', spec, name: 'stable report' })],
      ),
    )
    const manifest = createManifest(runId, [
      createEntry({
        id: 'deterministic-entry',
        runId,
        cid: '0-0',
        spec,
        name: 'stable report',
        artifactPath: mediaPath,
      }),
    ])

    await generateVideoReportForRun({ outputDir, runId, manifest })
    const first = await fs.readFile(
      path.join(outputDir, 'video-report.html'),
      'utf8',
    )
    await generateVideoReportForRun({ outputDir, runId, manifest })
    const second = await fs.readFile(
      path.join(outputDir, 'video-report.html'),
      'utf8',
    )

    expect(second).toBe(first)
    expect(second).toContain('2026-07-18T00:00:02.000Z')
    expect(second).toContain('./corrupt-but-linkable.webm')
    expect(second).not.toContain('missing-media-artifact')
  })

  it('associates one spec-scoped capture with multiple test outcomes', async () => {
    const outputDir = await createTempDir()
    const runId = 'spec-run'
    const spec = 'tests/specs/spec-scope.ts'
    await fs.writeFile(path.join(outputDir, 'spec.webm'), 'video')
    const outcomes = ['first test', 'second test'].map((name) =>
      createOutcome({ runId, cid: '0-0', spec, name }),
    )
    await writeReporterFragment(
      outputDir,
      createFragment(runId, '0-0', [spec], outcomes),
    )
    const manifest = createManifest(runId, [
      createEntry({
        id: 'spec-entry',
        runId,
        cid: '0-0',
        spec,
        scope: 'spec',
        artifactPath: 'spec.webm',
      }),
    ])
    const run = manifest.runs[0]
    const entry = run?.entries[0]
    if (!run || !entry?.capture.segments[0]) {
      throw new TypeError('Expected spec report fixture')
    }
    run.diagnostics = [
      {
        code: 'malformed-final-journal-line',
        journal: 'journal.jsonl',
        line: 4,
      },
    ]
    entry.capture.final = {
      ...entry.capture.segments[0],
      size: 2048,
    }
    const generated = await generateVideoReportForRun({
      outputDir,
      runId,
      manifest,
    })
    expect(generated).toMatchObject({ itemCount: 2, diagnosticCount: 1 })
    const html = await fs.readFile(generated?.path ?? '', 'utf8')
    expect(html).toContain('manifest-diagnostic')
    expect(html).toContain('2.0 KiB')
  })

  it('associates duplicate test identities with distinct manifest entries', async () => {
    const outputDir = await createTempDir()
    const runId = 'duplicate-identity-run'
    const spec = 'tests/specs/duplicate-identity.ts'
    await Promise.all([
      fs.writeFile(path.join(outputDir, 'first.webm'), 'first'),
      fs.writeFile(path.join(outputDir, 'second.webm'), 'second'),
    ])
    const outcomes = ['first-outcome', 'second-outcome'].map((uid) => ({
      ...createOutcome({
        runId,
        cid: '0-0',
        spec,
        name: 'same title',
        fullName: 'suite same title',
      }),
      uid,
    }))
    const manifest = createManifest(runId, [
      createEntry({
        id: 'first-entry',
        runId,
        cid: '0-0',
        spec,
        name: 'same title',
        fullName: 'suite same title',
        artifactPath: 'first.webm',
      }),
      createEntry({
        id: 'second-entry',
        runId,
        cid: '0-0',
        spec,
        name: 'same title',
        fullName: 'suite same title',
        artifactPath: 'second.webm',
      }),
    ])
    const run = manifest.runs[0]
    if (!run) {
      throw new TypeError('Expected duplicate identity report fixture')
    }

    const model = await createReportModel({
      outputDir,
      runId,
      fragments: [createFragment(runId, '0-0', [spec], outcomes)],
      run,
      initialDiagnostics: [],
    })

    expect(
      model.items.map((item) => ({ id: item.id, path: item.media[0]?.path })),
    ).toEqual([
      { id: '0-0-first-outcome-1', path: 'first.webm' },
      { id: '0-0-second-outcome-1', path: 'second.webm' },
    ])
    expect(model.diagnostics).toEqual([])
  })

  it('associates Cucumber step outcomes through their scenario identity', async () => {
    const outputDir = await createTempDir()
    const runId = 'cucumber-run'
    const spec = 'tests/features/video.feature'
    const scenario = 'records a Cucumber scenario'
    await fs.writeFile(path.join(outputDir, 'scenario.webm'), 'video')
    const outcomes = ['Given a page', 'Then it is visible'].map((name) =>
      createOutcome({
        runId,
        cid: '0-0',
        spec,
        name,
        fullName: `0: ${name}`,
        containerName: scenario,
      }),
    )
    await writeReporterFragment(
      outputDir,
      createFragment(runId, '0-0', [spec], outcomes),
    )
    const generated = await generateVideoReportForRun({
      outputDir,
      runId,
      manifest: createManifest(runId, [
        createEntry({
          id: 'scenario-entry',
          runId,
          cid: '0-0',
          spec,
          name: scenario,
          fullName: scenario,
          artifactPath: 'scenario.webm',
        }),
      ]),
    })
    expect(generated).toMatchObject({ itemCount: 2, diagnosticCount: 0 })
    expect(await fs.readFile(generated?.path ?? '', 'utf8')).toContain(scenario)
  })

  it('prefers a Cucumber step container over another matching scenario title', async () => {
    const outputDir = await createTempDir()
    const runId = 'cucumber-title-collision-run'
    const spec = 'tests/features/title-collision.feature'
    await Promise.all([
      fs.writeFile(path.join(outputDir, 'checkout.webm'), 'checkout'),
      fs.writeFile(path.join(outputDir, 'login.webm'), 'login'),
    ])
    const manifest = createManifest(runId, [
      createEntry({
        id: 'checkout-entry',
        runId,
        cid: '0-0',
        spec,
        name: 'Checkout flow',
        fullName: 'Checkout flow',
        artifactPath: 'checkout.webm',
      }),
      createEntry({
        id: 'login-entry',
        runId,
        cid: '0-0',
        spec,
        name: 'Log in',
        fullName: 'Log in',
        artifactPath: 'login.webm',
      }),
    ])
    const run = manifest.runs[0]
    if (!run) {
      throw new TypeError('Expected Cucumber collision report fixture')
    }

    const model = await createReportModel({
      outputDir,
      runId,
      fragments: [
        createFragment(
          runId,
          '0-0',
          [spec],
          [
            createOutcome({
              runId,
              cid: '0-0',
              spec,
              name: 'Log in',
              fullName: '0: Log in',
              containerName: 'Checkout flow',
            }),
          ],
        ),
      ],
      run,
      initialDiagnostics: [],
    })

    expect(model.items[0]?.media[0]?.path).toBe('checkout.webm')
    expect(model.diagnostics).toEqual([
      expect.objectContaining({
        code: 'unmatched-manifest-entry',
        message: expect.stringContaining('login-entry'),
      }),
    ])
  })

  it('reports missing, corrupt, and incomplete input without aborting report creation', async () => {
    const outputDir = await createTempDir()
    const runId = 'diagnostic-run'
    const spec = 'tests/specs/missing.ts'
    await writeReporterFragment(
      outputDir,
      createFragment(
        runId,
        '0-0',
        [spec],
        [createOutcome({ runId, cid: '0-0', spec, name: 'missing media' })],
      ),
    )
    const fragmentDir = getReporterFragmentDirectory(outputDir, runId)
    await fs.writeFile(path.join(fragmentDir, 'corrupt.json'), '{', 'utf8')
    await fs.writeFile(path.join(fragmentDir, 'ignored.txt'), 'ignored', 'utf8')
    await fs.writeFile(
      path.join(fragmentDir, 'unsafe.json'),
      JSON.stringify({
        ...createFragment(runId, '0-0', [spec], []),
        reportFileName: '../unsafe.html',
      }),
      'utf8',
    )

    const missingManifest = await generateVideoReportForRun({
      outputDir,
      runId,
    })
    expect(missingManifest?.diagnosticCount).toBe(3)
    expect(await fs.readFile(missingManifest?.path ?? '', 'utf8')).toContain(
      'missing-manifest',
    )

    await fs.writeFile(path.join(outputDir, 'manifest.json'), '{}', 'utf8')
    const invalidManifest = await generateVideoReportForRun({
      outputDir,
      runId,
    })
    expect(await fs.readFile(invalidManifest?.path ?? '', 'utf8')).toContain(
      'invalid-manifest',
    )

    await fs.writeFile(path.join(outputDir, 'manifest.json'), '{', 'utf8')
    const corruptManifest = await generateVideoReportForRun({
      outputDir,
      runId,
    })
    expect(await fs.readFile(corruptManifest?.path ?? '', 'utf8')).toContain(
      'invalid-manifest',
    )

    const missingMedia = await generateVideoReportForRun({
      outputDir,
      runId,
      manifest: createManifest(runId, [
        createEntry({
          id: 'missing-entry',
          runId,
          cid: '0-0',
          spec,
          name: 'missing media',
          artifactPath: 'not-there.webm',
        }),
      ]),
    })
    expect(await fs.readFile(missingMedia?.path ?? '', 'utf8')).toContain(
      'missing-media-artifact',
    )

    const missingRun = await generateVideoReportForRun({
      outputDir,
      runId,
      manifest: createManifest('another-run', []),
    })
    expect(await fs.readFile(missingRun?.path ?? '', 'utf8')).toContain(
      'missing-manifest-run',
    )
  })

  it('lets the service launcher generate the report after manifest aggregation', async () => {
    const outputDir = await createTempDir()
    const launcher = new WdioPuppeteerVideoLauncher({ outputDir })
    const workerConfig: Record<string, unknown> = {}
    await launcher.onPrepare()
    await launcher.onWorkerStart(
      '0-0',
      { browserName: 'chrome' },
      [path.resolve('tests/specs/empty.ts')],
      workerConfig,
    )
    const context = readManifestRunContext(workerConfig)
    expect(context).toBeDefined()
    if (!context) {
      throw new TypeError('Expected launcher manifest context')
    }
    await writeReporterFragment(
      outputDir,
      createFragment(context.runId, '0-0', ['tests/specs/empty.ts'], []),
    )
    await launcher.onComplete(0)
    const html = await fs.readFile(
      path.join(outputDir, 'video-report.html'),
      'utf8',
    )
    expect(html).toContain(context.runId)
    expect(html).toContain('No test outcomes were captured')
  })
})

const assertOfflineFilterScript = (html: string): void => {
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html)?.[1]
  expect(script).toBeDefined()
  const listeners = new Map<string, () => void>()
  const createFilter = (id: string) => ({
    value: 'all',
    addEventListener: (_event: string, listener: () => void) => {
      listeners.set(id, listener)
    },
  })
  const filters = new Map([
    ['#status-filter', createFilter('status')],
    ['#spec-filter', createFilter('spec')],
    ['#browser-filter', createFilter('browser')],
    ['#retry-filter', createFilter('retry')],
  ])
  const cards = [
    {
      dataset: {
        status: 'passed',
        spec: 'one.ts',
        browser: 'chrome',
        retried: 'false',
      },
      hidden: false,
    },
    {
      dataset: {
        status: 'failed',
        spec: 'two.ts',
        browser: 'edge',
        retried: 'true',
      },
      hidden: false,
    },
  ]
  const empty = { hidden: true }
  const document = {
    querySelector: (selector: string) =>
      selector === '#empty-filter' ? empty : filters.get(selector),
    querySelectorAll: () => cards,
  }
  vm.runInNewContext(script ?? '', { document })
  const statusFilter = filters.get('#status-filter')
  if (!statusFilter) {
    throw new TypeError('Expected status filter')
  }
  statusFilter.value = 'failed'
  listeners.get('status')?.()
  expect(cards.map((card) => card.hidden)).toEqual([true, false])
  expect(empty.hidden).toBe(true)
}
