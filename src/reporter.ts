import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WDIOReporter, { type RunnerStats, type TestStats } from '@wdio/reporter'
import {
  normalizeReportFileName,
  writeReporterFragment,
} from './reporter/fragments.js'
import {
  REPORTER_FRAGMENT_SCHEMA_VERSION,
  type ReporterBrowserIdentity,
  type ReporterErrorDetails,
  type ReporterFragmentV1,
  type ReporterTestOutcome,
  type ReporterTestStatus,
  type WdioPuppeteerVideoReporterOptions,
} from './reporter/types.js'
import {
  normalizeManifestPath,
  readManifestRunContext,
  readManifestWorkerContext,
} from './service/manifest-runtime.js'

interface PendingReporterFragment {
  schemaVersion: typeof REPORTER_FRAGMENT_SCHEMA_VERSION
  runId: string
  cid: string
  specs: string[]
  browser: ReporterBrowserIdentity
  reportFileName: string
  startedAt: string
  outcomes: ReporterTestOutcome[]
}

const stderrWriteStream = {
  write(content: unknown): boolean {
    process.stderr.write(String(content))
    return true
  },
}

/**
 * Dependency-free static HTML reporter companion for the video service.
 * Test event handlers only update in-memory state; the final fragment flush is
 * the sole asynchronous reporter operation guarded by `isSynchronised`.
 */
export class WdioPuppeteerVideoReporter extends WDIOReporter {
  private readonly _reportFileName: string
  private _fragment: PendingReporterFragment | undefined
  private _outputDir: string
  private _runnerRetry = 0
  private _runnerUsesRetries = false
  private readonly _capturedOutcomes = new Set<string>()
  private _flushComplete = true

  constructor(options: WdioPuppeteerVideoReporterOptions = {}) {
    super({
      ...options,
      stdout: true,
      writeStream: options.writeStream ?? stderrWriteStream,
    })
    this._reportFileName = normalizeReportFileName(options.reportFileName)
    this._outputDir = path.resolve(options.outputDir ?? 'videos')
  }

  override get isSynchronised(): boolean {
    return this._flushComplete
  }

  override onRunnerStart(runnerStats: RunnerStats): void {
    const context = readManifestRunContext(runnerStats.config)
    const workerContext = readManifestWorkerContext(
      runnerStats.config,
      runnerStats.cid,
    )
    this._outputDir = context?.outputDir ?? this._outputDir
    this._runnerRetry = workerContext?.specFileRetryAttempt ?? 0
    this._runnerUsesRetries =
      this._runnerRetry > 0 ||
      normalizeRetryCount(runnerStats.config.specFileRetries) > 0
    this._capturedOutcomes.clear()
    this._fragment = {
      schemaVersion: REPORTER_FRAGMENT_SCHEMA_VERSION,
      runId: context?.runId ?? `unassociated-${randomUUID()}`,
      cid: runnerStats.cid,
      specs: runnerStats.specs.map(normalizeReporterSpec),
      browser: resolveBrowserIdentity(runnerStats.capabilities),
      reportFileName: this._reportFileName,
      startedAt: runnerStats.start.toISOString(),
      outcomes: [],
    }
  }

  override onTestRetry(testStats: TestStats): void {
    this._captureOutcome(testStats, true)
  }

  override onTestPass(testStats: TestStats): void {
    this._captureOutcome(testStats, false)
  }

  override onTestFail(testStats: TestStats): void {
    this._captureOutcome(testStats, false)
  }

  override onTestSkip(testStats: TestStats): void {
    this._captureOutcome(testStats, false)
  }

  override onTestPending(testStats: TestStats): void {
    this._captureOutcome(testStats, false)
  }

  override onTestEnd(testStats: TestStats): void {
    this._captureOutcome(testStats, false)
  }

  override onRunnerEnd(_runnerStats: RunnerStats): void {
    const fragment = this._fragment
    if (!fragment) {
      return
    }
    this._fragment = undefined
    const completedFragment: ReporterFragmentV1 = {
      ...fragment,
      completedAt: new Date().toISOString(),
    }
    this._flushComplete = false
    void writeReporterFragment(this._outputDir, completedFragment)
      .catch((error) => {
        this.write(
          `[WdioPuppeteerVideoReporter] Failed to flush reporter fragment: ${describeError(error)}\n`,
        )
      })
      .finally(() => {
        this._flushComplete = true
      })
  }

  private _captureOutcome(testStats: TestStats, retryEvent: boolean): void {
    const fragment = this._fragment
    if (!fragment) {
      return
    }
    const attempt =
      this._runnerRetry + normalizeRetryCount(testStats.retries) + 1
    const status = normalizeTestStatus(testStats.state)
    const deduplicationKey = `${testStats.uid}\0${attempt.toString()}\0${status}`
    if (this._capturedOutcomes.has(deduplicationKey)) {
      return
    }
    this._capturedOutcomes.add(deduplicationKey)
    const errors = collectErrors(testStats)
    const fullName = testStats.fullTitle?.trim()
    const parent = testStats.parent?.trim()
    const containerName = this._resolveScenarioName()
    const testName = testStats.title?.trim() || fullName || 'unknown test'
    fragment.outcomes.push({
      uid: testStats.uid,
      runId: fragment.runId,
      cid: fragment.cid,
      spec: normalizeReporterSpec(
        this.currentSpec ?? fragment.specs[0] ?? 'unknown-spec',
      ),
      browser: fragment.browser,
      test: {
        name: testName,
        ...(fullName ? { fullName } : {}),
        ...(parent ? { parent } : {}),
        ...(containerName ? { containerName } : {}),
      },
      attempt,
      retried: retryEvent || attempt > 1 || this._runnerUsesRetries,
      status,
      durationMs: Math.max(0, Math.floor(testStats.duration)),
      ...(testStats.pendingReason
        ? { pendingReason: testStats.pendingReason }
        : {}),
      ...(errors.length > 0 ? { errors } : {}),
    })
  }

  private _resolveScenarioName(): string | undefined {
    return [...this.currentSuites]
      .reverse()
      .find((suite) => suite.type === 'scenario')
      ?.title.trim()
  }
}

const normalizeRetryCount = (value: number | undefined): number => {
  return Number.isInteger(value) && (value ?? 0) > 0 ? (value as number) : 0
}

const normalizeReporterSpec = (value: string): string => {
  const filePath = value.startsWith('file:') ? fileURLToPath(value) : value
  return normalizeManifestPath(filePath, process.cwd())
}

const normalizeTestStatus = (value: string): ReporterTestStatus => {
  if (
    value === 'passed' ||
    value === 'failed' ||
    value === 'skipped' ||
    value === 'pending'
  ) {
    return value
  }
  return 'unknown'
}

const collectErrors = (testStats: TestStats): ReporterErrorDetails[] => {
  const errors = testStats.errors ?? (testStats.error ? [testStats.error] : [])
  return errors.map((error) => ({
    message: error.message || String(error),
    ...(error.stack ? { stack: error.stack } : {}),
  }))
}

const resolveBrowserIdentity = (
  capabilities: WebdriverIO.Capabilities,
): ReporterBrowserIdentity => {
  const record = capabilities as Record<string, unknown>
  const name = readNonEmptyString(record.browserName) ?? 'unknown'
  const version =
    readNonEmptyString(record.browserVersion) ??
    readNonEmptyString(record.version)
  return {
    name,
    ...(version ? { version } : {}),
  }
}

const readNonEmptyString = (value: unknown): string | undefined => {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

const describeError = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}

export type { WdioPuppeteerVideoReporterOptions } from './reporter/types.js'
export default WdioPuppeteerVideoReporter
