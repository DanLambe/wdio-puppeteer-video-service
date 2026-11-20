import type { ManifestFramework, ManifestResult } from '../manifest.js'
import type {
  LogLevel,
  ResolvedWdioPuppeteerVideoServiceOptions,
} from '../types.js'
import type { SlugMetadata } from '../video-name-utils.js'
import type { AllureAttachmentResult } from './allure-integration.js'
import type { SegmentTab } from './capture-session.js'
import type { ResolvedRetryContext } from './constants.js'
import { type ServiceLogger, shouldLog } from './logging.js'
import type {
  CompleteManifestEntryOptions,
  ManifestEntityInput,
} from './manifest-runtime.js'
import { describeError } from './normalization.js'
import { PARALLEL_MODE_UNSUPPORTED_REASON } from './parallel-mode.js'
import { isVideoArtifactPath } from './paths.js'
import type {
  RecordingEntity,
  RecordingEntityOutcome,
} from './recording-entity.js'
import {
  createCompletedManifestOptions,
  createRetryTrackingKey,
  decideRecordingStart,
  evaluateRecordingEligibility,
  type RecordingAvailability,
  resolveRecordingAttempt,
  shouldRetainRecording,
} from './recording-policy.js'

export interface RecordingManifestPort {
  readonly currentEntryId: string | undefined
  beginEntity(input: ManifestEntityInput): Promise<string>
  completeCurrent(
    options: CompleteManifestEntryOptions,
  ): Promise<string | undefined>
  recordResult(result: ManifestResult): Promise<void>
  recordSkippedEntity(
    input: ManifestEntityInput,
    options: { readonly reason: string; readonly result: ManifestResult },
  ): Promise<string>
  setCurrentAttempt(attempt: number): void
}

export interface RecordingAllurePort {
  attachRetainedVideos(
    paths: readonly string[],
    passed: boolean,
  ): Promise<AllureAttachmentResult>
}

export interface RecordingMediaFinalization {
  /** Why a stopped segment is incomplete; its entry is recorded as failed. */
  readonly captureFailure?: string
  readonly deferred: boolean
  readonly paths: readonly string[]
  /**
   * Why processing the kept segments failed. The paths are then the files on
   * disk, processed or not, and the entry is recorded as failed.
   */
  readonly processingFailure?: { readonly error: unknown }
  /** Tabs of the retained segments, keyed by part number. */
  readonly tabs?: ReadonlyMap<number, SegmentTab>
}

export interface WorkerRecordingActions {
  finalizeMedia(
    passed: boolean,
    keepArtifacts: boolean,
  ): Promise<RecordingMediaFinalization>
  /** Ends a recording before its outcome is known, keeping its media. */
  finalizeMediaWithoutOutcome(): Promise<RecordingMediaFinalization>
  getAvailability(): RecordingAvailability
  getRecordedPaths(): readonly string[]
  isRecordingActive(): boolean
  resetRecording(): Promise<void>
  runSerialized(task: () => Promise<void>): Promise<void>
  startRecording(
    metadata: Readonly<SlugMetadata>,
    retryCount: number,
  ): Promise<boolean>
}

export interface WorkerRecordingCoordinatorOptions {
  readonly actions: WorkerRecordingActions
  readonly allure?: RecordingAllurePort
  readonly getLogLevel: () => LogLevel
  readonly log: ServiceLogger
  readonly options: ResolvedWdioPuppeteerVideoServiceOptions
}

export interface RecordingCoordinatorSession {
  readonly framework: ManifestFramework
  readonly manifest?: RecordingManifestPort
  readonly specFileRetryAttempt: number
}

export interface WorkerRecordingCoordinatorPort {
  readonly framework: ManifestFramework
  readonly isSpecScope: boolean
  beginEntity(entity: RecordingEntity): Promise<void>
  beginWorker(specPaths: readonly string[]): void
  configureSession(session: RecordingCoordinatorSession): void
  endEntity(outcome: RecordingEntityOutcome): Promise<void>
  /**
   * Ends a test-scoped recording whose result has not arrived, as when the
   * session reloads or the worker ends mid test. Its media is kept, and its
   * entry lists it; a result that arrives later is added to that entry. Runs
   * inside a serialized recording task.
   */
  finalizeInterruptedRecording(): Promise<void>
  finalizeSpecRecording(): Promise<void>
  resetWorkerState(): void
}

/** How a recording ends: with its entity's outcome, or before it arrives. */
type RecordingFinalizationMode =
  | {
      readonly kind: 'outcome'
      readonly passed: boolean
      readonly result: ManifestResult
    }
  | { readonly kind: 'interrupted' }

interface FinalizationFailures {
  allureError?: Error | undefined
  captureFailure?: string | undefined
  processingFailure?: { readonly error: unknown } | undefined
}

export class WorkerRecordingCoordinator
  implements WorkerRecordingCoordinatorPort
{
  private readonly actions: WorkerRecordingActions
  private readonly allure: RecordingAllurePort | undefined
  private readonly entityAttemptCount = new Map<string, number>()
  private frameworkName: ManifestFramework = 'unknown'
  private readonly getLogLevel: () => LogLevel
  private readonly log: ServiceLogger
  private manifest: RecordingManifestPort | undefined
  private readonly options: ResolvedWdioPuppeteerVideoServiceOptions
  private readonly patternRegexCache = new Map<string, RegExp>()
  private activeRecordingRetryCount = 0
  private specFileRetryAttempt = 0
  private specHadFailure = false
  private specPaths: readonly string[] = Object.freeze([])
  private parallelSpecRecorded = false

  constructor(options: WorkerRecordingCoordinatorOptions) {
    this.actions = options.actions
    this.allure = options.allure
    this.getLogLevel = options.getLogLevel
    this.log = options.log
    this.options = options.options
  }

  get framework(): ManifestFramework {
    return this.frameworkName
  }

  get isSpecScope(): boolean {
    return this.options.recording.scope === 'spec'
  }

  configureSession(session: RecordingCoordinatorSession): void {
    this.frameworkName = session.framework
    this.manifest = session.manifest
    this.specFileRetryAttempt = session.specFileRetryAttempt
  }

  beginWorker(specPaths: readonly string[]): void {
    this.specPaths = Object.freeze([...specPaths])
    this.resetEntityState()
  }

  // The manifest has one current entry, and media finalization reports to it.
  // A framework can time out a completion hook while its finalization still
  // runs, then start the next entity, so every step that reads or moves the
  // current entry runs in the recording's serialized order: an entity's entry
  // is completed before the next one begins.
  async beginEntity(entity: RecordingEntity): Promise<void> {
    if (this.testsOverlap) {
      await this.recordParallelEntity(entity)
      return
    }
    await this.actions.runSerialized(async () => {
      await this.beginSerializedEntity(entity)
    })
  }

  async endEntity(outcome: RecordingEntityOutcome): Promise<void> {
    if (this.testsOverlap) {
      // Overlapping tests cannot be told apart here, so no result is recorded.
      return
    }
    await this.actions.runSerialized(async () => {
      await this.endSerializedEntity(outcome)
    })
  }

  async finalizeInterruptedRecording(): Promise<void> {
    await this.finalizeRecording({ kind: 'interrupted' })
  }

  async finalizeSpecRecording(): Promise<void> {
    // Manifest results were accumulated per entity; do not overwrite all-skipped
    // specs with the non-failing boolean used for retention and Allure.
    await this.finalizeRecording({
      kind: 'outcome',
      passed: !this.specHadFailure,
      result: 'unknown',
    })
  }

  resetWorkerState(): void {
    this.resetEntityState()
  }

  /** In WebdriverIO's parallelMode, a worker's tests run at the same time. */
  private get testsOverlap(): boolean {
    return (
      this.actions.getAvailability().reason === PARALLEL_MODE_UNSUPPORTED_REASON
    )
  }

  private async recordParallelEntity(entity: RecordingEntity): Promise<void> {
    if (this.isSpecScope) {
      if (this.parallelSpecRecorded) {
        return
      }
      this.parallelSpecRecorded = true
    }
    await this.manifest?.recordSkippedEntity(
      {
        test: entity.manifestTest,
        scope: this.options.recording.scope,
        specPaths: [...this.specPaths],
      },
      {
        reason: PARALLEL_MODE_UNSUPPORTED_REASON,
        result: entity.manifestResultWhenSkipped,
      },
    )
  }

  private async beginSerializedEntity(entity: RecordingEntity): Promise<void> {
    const manifestEntryAlreadyActive =
      this.isSpecScope && !!this.manifest?.currentEntryId
    await this.manifest?.beginEntity({
      test: entity.manifestTest,
      scope: this.options.recording.scope,
      specPaths: [...this.specPaths],
    })

    const eligibility = evaluateRecordingEligibility(
      entity,
      this.actions.getAvailability(),
      this.options.recording.filters,
      this.patternRegexCache,
    )
    if (!eligibility.eligible) {
      await this.completeSkippedEntity(
        entity,
        eligibility.reason,
        manifestEntryAlreadyActive,
      )
      return
    }
    await this.startEligibleEntity(entity, manifestEntryAlreadyActive)
  }

  private async endSerializedEntity(
    outcome: RecordingEntityOutcome,
  ): Promise<void> {
    // WDIO reports passed=false for runtime skips; they are not test failures.
    const nonFailing = outcome.passed || outcome.manifestResult === 'skipped'
    let manifestFailure: { readonly error: unknown } | undefined
    try {
      await this.manifest?.recordResult(outcome.manifestResult)
    } catch (error) {
      manifestFailure = { error }
    }

    if (this.isSpecScope) {
      if (!nonFailing) {
        this.specHadFailure = true
      }
    } else {
      await this.finalizeRecording({
        kind: 'outcome',
        passed: nonFailing,
        result: outcome.manifestResult,
      })
    }

    if (manifestFailure) {
      throw manifestFailure.error
    }
  }

  private resetEntityState(): void {
    this.parallelSpecRecorded = false
    this.activeRecordingRetryCount = 0
    this.entityAttemptCount.clear()
    this.patternRegexCache.clear()
    this.specHadFailure = false
  }

  private async startEligibleEntity(
    entity: RecordingEntity,
    manifestEntryAlreadyActive: boolean,
  ): Promise<void> {
    const inferredEntityRetry = this.consumeInferredRetry(entity)
    const retryContext = resolveRecordingAttempt({
      entity,
      inferredEntityRetry,
      specFileRetryAttempt: this.specFileRetryAttempt,
    })
    this.manifest?.setCurrentAttempt(retryContext.effectiveRetryCount + 1)
    const decision = decideRecordingStart({
      attempts: this.options.recording.attempts,
      entity,
      retryContext,
      scope: this.options.recording.scope,
      specPaths: this.specPaths,
      specRecordingActive: this.actions.isRecordingActive(),
    })
    this.logRetryDecision(entity.label, decision.retryContext, decision.action)

    if (decision.action === 'skip') {
      this.logRetrySkip(entity.label, decision.retryContext)
      await this.completeSkippedEntity(
        entity,
        decision.reason,
        manifestEntryAlreadyActive,
      )
      return
    }
    if (decision.action === 'continue-spec') {
      this.activeRecordingRetryCount = Math.max(
        this.activeRecordingRetryCount,
        decision.retryContext.effectiveRetryCount,
      )
      return
    }

    let startFailure: { readonly error: unknown } | undefined
    let started = false
    try {
      started = await this.actions.startRecording(
        decision.metadata,
        decision.retryContext.effectiveRetryCount,
      )
    } catch (error) {
      startFailure = { error }
    }
    if (started) {
      this.activeRecordingRetryCount = decision.retryContext.effectiveRetryCount
      return
    }

    const reason = startFailure
      ? describeError(startFailure.error)
      : (this.actions.getAvailability().reason ?? 'recording-start-failed')
    try {
      await this.manifest?.completeCurrent({
        decision: 'failed',
        result: 'unknown',
        reason,
        processingOutcome: 'failed',
        processingOperation: 'capture',
      })
    } finally {
      await this.actions.resetRecording()
      this.activeRecordingRetryCount = 0
    }

    if (startFailure) {
      throw startFailure.error
    }
    if (this.options.failurePolicy === 'error') {
      throw new Error(`[WdioPuppeteerVideoService] ${reason}`)
    }
  }

  private consumeInferredRetry(entity: RecordingEntity): number | undefined {
    const retryTrackingKey = createRetryTrackingKey(entity)
    const inferredRetry = this.entityAttemptCount.get(retryTrackingKey) ?? 0
    this.entityAttemptCount.set(retryTrackingKey, inferredRetry + 1)

    if (entity.explicitFrameworkRetry !== undefined) {
      // Mocha reports its own attempt number, so repeated executions of an
      // identically named entity must not be inferred as retries.
      return undefined
    }

    // Cucumber retries a scenario without exposing an attempt number, so the
    // per-entity execution count is the only available signal. Track it for
    // every `recording.attempts` mode so retention, manifest attempts, and
    // reporter joins observe the same attempt.
    return inferredRetry
  }

  private async completeSkippedEntity(
    entity: RecordingEntity,
    reason: string,
    manifestEntryAlreadyActive: boolean,
  ): Promise<void> {
    if (manifestEntryAlreadyActive) {
      return
    }
    await this.manifest?.completeCurrent({
      decision: 'skipped',
      result: entity.manifestResultWhenSkipped,
      reason,
      processingOutcome: 'skipped',
    })
  }

  /**
   * Finalizes the active recording and completes its manifest entry. With an
   * outcome, retention decides what is kept and the kept videos go to Allure;
   * a recording interrupted before its outcome keeps its media.
   */
  private async finalizeRecording(
    mode: RecordingFinalizationMode,
  ): Promise<void> {
    if (!this.actions.isRecordingActive()) {
      return
    }

    const outcome = mode.kind === 'outcome' ? mode : undefined
    const result = outcome?.result ?? 'unknown'
    const keepArtifacts =
      outcome === undefined ||
      shouldRetainRecording({
        passed: outcome.passed,
        retain: this.options.recording.retain,
        retryCount: this.activeRecordingRetryCount,
      })
    const failures: FinalizationFailures = {}
    try {
      const finalized = outcome
        ? await this.actions.finalizeMedia(outcome.passed, keepArtifacts)
        : await this.actions.finalizeMediaWithoutOutcome()
      failures.captureFailure = finalized.captureFailure
      failures.processingFailure = finalized.processingFailure
      await this.manifest?.completeCurrent(
        createCompletedManifestOptions({
          captureFailed: finalized.captureFailure !== undefined,
          deferred: finalized.deferred,
          keepArtifacts,
          result,
          paths: finalized.paths,
          processing: this.options.processing,
          ...(finalized.processingFailure
            ? {
                processingFailure: describeError(
                  finalized.processingFailure.error,
                ),
              }
            : {}),
          ...(finalized.tabs ? { tabs: finalized.tabs } : {}),
        }),
      )
      if (outcome) {
        // Media that failed processing is still the test's evidence.
        const allureResult = await this.allure?.attachRetainedVideos(
          finalized.paths.filter(isVideoArtifactPath),
          outcome.passed,
        )
        failures.allureError = allureResult?.error
      }
    } catch (error) {
      await this.manifest
        ?.completeCurrent({
          decision: 'failed',
          result,
          paths: [...this.actions.getRecordedPaths()],
          reason: describeError(error),
          processingOutcome: 'failed',
        })
        .catch(() => undefined)
      // A later reporting error never hides why processing failed.
      throw failures.processingFailure
        ? failures.processingFailure.error
        : error
    } finally {
      await this.actions.resetRecording()
      this.activeRecordingRetryCount = 0
    }
    this.throwFinalizationFailure(failures)
  }

  private throwFinalizationFailure(failures: FinalizationFailures): void {
    if (failures.processingFailure) {
      // Thrown by processing itself, as before the entry was reported.
      throw failures.processingFailure.error
    }
    if (this.options.failurePolicy !== 'error') {
      return
    }
    // Already warned when the segment stopped; the partial file stays
    // attached and in the manifest for diagnosis.
    if (failures.captureFailure) {
      throw new Error(`[WdioPuppeteerVideoService] ${failures.captureFailure}`)
    }
    if (failures.allureError) {
      throw failures.allureError
    }
  }

  private logRetryDecision(
    entityLabel: string,
    retryContext: ResolvedRetryContext,
    action: 'continue-spec' | 'skip' | 'start',
  ): void {
    if (
      this.options.recording.attempts !== 'retries' ||
      !shouldLog('trace', this.getLogLevel())
    ) {
      return
    }

    const decision = action === 'skip' ? 'skip' : 'record'
    this.log(
      'trace',
      `[WdioPuppeteerVideoService] Retry decision for "${entityLabel}": ${decision} (effectiveRetry=${retryContext.effectiveRetryCount}, frameworkRetry=${retryContext.explicitFrameworkRetry ?? 0}, specFileRetry=${retryContext.specFileRetryAttempt}, inferredRetry=${retryContext.inferredEntityRetry ?? 0}).`,
    )
  }

  private logRetrySkip(
    entityLabel: string,
    retryContext: ResolvedRetryContext,
  ): void {
    if (
      this.options.recording.attempts !== 'retries' ||
      !shouldLog('debug', this.getLogLevel())
    ) {
      return
    }

    this.log(
      'debug',
      `[WdioPuppeteerVideoService] Skipping recording for "${entityLabel}" because retryCount=0 (frameworkRetry=${retryContext.explicitFrameworkRetry ?? 0}, specFileRetry=${retryContext.specFileRetryAttempt}, inferredRetry=${retryContext.inferredEntityRetry ?? 0}).`,
    )
  }
}

export type RecordingCoordinatorFactory = (
  options: WorkerRecordingCoordinatorOptions,
) => WorkerRecordingCoordinatorPort

export const createWorkerRecordingCoordinator: RecordingCoordinatorFactory = (
  options,
) => new WorkerRecordingCoordinator(options)
