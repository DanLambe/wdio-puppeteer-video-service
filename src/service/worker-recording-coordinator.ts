import type { ManifestFramework, ManifestResult } from '../manifest.js'
import type {
  LogLevel,
  ResolvedWdioPuppeteerVideoServiceOptions,
} from '../types.js'
import type { SlugMetadata } from '../video-name-utils.js'
import type { AllureAttachmentResult } from './allure-integration.js'
import type { ResolvedRetryContext } from './constants.js'
import { type ServiceLogger, shouldLog } from './logging.js'
import type {
  CompleteManifestEntryOptions,
  ManifestEntityInput,
} from './manifest-runtime.js'
import { describeError } from './normalization.js'
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
  setCurrentAttempt(attempt: number): void
}

export interface RecordingAllurePort {
  attachRetainedVideos(
    paths: readonly string[],
    passed: boolean,
  ): Promise<AllureAttachmentResult>
}

export interface RecordingMediaFinalization {
  readonly deferred: boolean
  readonly paths: readonly string[]
}

export interface WorkerRecordingActions {
  finalizeMedia(
    passed: boolean,
    keepArtifacts: boolean,
  ): Promise<RecordingMediaFinalization>
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
  finalizeSpecRecording(): Promise<void>
  resetWorkerState(): void
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

  async beginEntity(entity: RecordingEntity): Promise<void> {
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

    await this.actions.runSerialized(async () => {
      await this.startEligibleEntity(entity, manifestEntryAlreadyActive)
    })
  }

  async endEntity(outcome: RecordingEntityOutcome): Promise<void> {
    let manifestFailure: { readonly error: unknown } | undefined
    try {
      await this.manifest?.recordResult(outcome.manifestResult)
    } catch (error) {
      manifestFailure = { error }
    }

    if (this.isSpecScope) {
      if (!outcome.passed) {
        this.specHadFailure = true
      }
    } else {
      await this.finalizeIfRecording(outcome.passed)
    }

    if (manifestFailure) {
      throw manifestFailure.error
    }
  }

  async finalizeSpecRecording(): Promise<void> {
    await this.finalizeCurrentRecording(!this.specHadFailure)
  }

  resetWorkerState(): void {
    this.resetEntityState()
  }

  private resetEntityState(): void {
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
    if (this.options.recording.attempts !== 'retries') {
      return undefined
    }

    const retryTrackingKey = createRetryTrackingKey(entity)
    const inferredRetry = this.entityAttemptCount.get(retryTrackingKey) ?? 0
    this.entityAttemptCount.set(retryTrackingKey, inferredRetry + 1)
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

  private async finalizeIfRecording(passed: boolean): Promise<void> {
    if (!this.actions.isRecordingActive()) {
      return
    }
    await this.actions.runSerialized(async () => {
      await this.finalizeCurrentRecording(passed)
    })
  }

  private async finalizeCurrentRecording(passed: boolean): Promise<void> {
    if (!this.actions.isRecordingActive()) {
      return
    }

    const keepArtifacts = shouldRetainRecording({
      passed,
      retain: this.options.recording.retain,
      retryCount: this.activeRecordingRetryCount,
    })
    let allureError: Error | undefined
    try {
      const finalized = await this.actions.finalizeMedia(passed, keepArtifacts)
      await this.manifest?.completeCurrent(
        createCompletedManifestOptions({
          deferred: finalized.deferred,
          keepArtifacts,
          passed,
          paths: finalized.paths,
          processing: this.options.processing,
        }),
      )
      const allureResult = await this.allure?.attachRetainedVideos(
        finalized.paths,
        passed,
      )
      allureError = allureResult?.error
    } catch (error) {
      await this.manifest
        ?.completeCurrent({
          decision: 'failed',
          result: passed ? 'passed' : 'failed',
          paths: [...this.actions.getRecordedPaths()],
          reason: describeError(error),
          processingOutcome: 'failed',
        })
        .catch(() => undefined)
      throw error
    } finally {
      await this.actions.resetRecording()
      this.activeRecordingRetryCount = 0
    }

    if (allureError && this.options.failurePolicy === 'error') {
      throw allureError
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
