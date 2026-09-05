import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Frameworks } from '@wdio/types'
import type {
  ManifestBrowser,
  ManifestCaptureDecision,
  ManifestEntryV1,
  ManifestFramework,
  ManifestMediaArtifact,
  ManifestProcessingOutcome,
  ManifestProtocol,
  ManifestRecordingScope,
  ManifestResult,
} from '../manifest.js'
import type { ManifestRunContext } from './manifest-context.js'
import {
  createManifestJournalPath,
  ManifestJournalWriter,
} from './manifest-journal.js'
import { hashPrivateValue, normalizeManifestPath } from './manifest-paths.js'
import type { MediaDimensions } from './media-metadata.js'

export { aggregateManifestRun } from './manifest-aggregation.js'
export type {
  ManifestRunContext,
  ManifestWorkerContext,
} from './manifest-context.js'
export {
  assignManifestRunContext,
  assignManifestWorkerContext,
  createManifestRunContext,
  hasManifestWorkerContexts,
  MANIFEST_RUN_CONFIG_KEY,
  MANIFEST_WORKER_CONFIG_KEY,
  readManifestRunContext,
  readManifestWorkerContext,
} from './manifest-context.js'
export {
  hashPrivateValue,
  normalizeManifestFramework,
  normalizeManifestPath,
} from './manifest-paths.js'

export interface ManifestEntityInput {
  readonly test?: Partial<
    Pick<Frameworks.Test, 'file' | 'fullName' | 'fullTitle' | 'title'>
  >
  readonly scope: ManifestRecordingScope
  readonly specPaths: string[]
  readonly attempt?: number
}

export interface CompleteManifestEntryOptions {
  readonly decision: ManifestCaptureDecision
  readonly result: ManifestResult
  readonly paths?: string[]
  readonly reason?: string
  readonly processingOutcome?: ManifestProcessingOutcome
  readonly processingOperation?: 'capture' | 'merge' | 'transcode'
}

interface ManifestEntryDraft {
  readonly id: string
  attempt: number
  readonly scope: ManifestRecordingScope
  readonly spec: string
  readonly test?: { name: string; fullName?: string }
  readonly startedAt: string
  captureStartedAt?: string
  captureStoppedAt?: string
  cumulativeResult: ManifestResult
}

export class ManifestWorkerRecorder {
  private readonly context: ManifestRunContext
  private readonly cid: string
  private readonly framework: ManifestFramework
  private readonly journal: ManifestJournalWriter
  private readonly readDimensions:
    | ((filePath: string) => Promise<MediaDimensions | undefined>)
    | undefined
  private readonly attempts = new Map<string, number>()
  private readonly completedEntries = new Map<string, ManifestEntryV1>()
  private browser: ManifestBrowser = {
    name: 'unknown',
    protocol: 'unsupported',
  }
  private sessionHash = hashPrivateValue('unavailable', 'unavailable')
  private current: ManifestEntryDraft | undefined
  private lastCompletedEntryId: string | undefined

  constructor(options: {
    readonly context: ManifestRunContext
    readonly cid: string
    readonly framework: ManifestFramework
    readonly failurePolicy?: 'error' | 'warn'
    readonly onJournalError?: (operation: string, error: unknown) => void
    readonly readDimensions?: (
      filePath: string,
    ) => Promise<MediaDimensions | undefined>
  }) {
    this.context = options.context
    this.cid = options.cid
    this.framework = options.framework
    this.readDimensions = options.readDimensions
    this.journal = new ManifestJournalWriter({
      failurePolicy: options.failurePolicy ?? 'warn',
      journalPath: createManifestJournalPath(options.context, options.cid),
      onError: options.onJournalError ?? (() => undefined),
    })
  }

  get currentEntryId(): string | undefined {
    return this.current?.id
  }

  configureSession(options: {
    readonly sessionId: string
    readonly browserName?: string
    readonly browserVersion?: string
    readonly protocol: ManifestProtocol
  }): void {
    this.sessionHash = hashPrivateValue(this.context.runId, options.sessionId)
    this.browser = {
      name: options.browserName?.trim() || 'unknown',
      protocol: options.protocol,
      ...(options.browserVersion?.trim()
        ? { version: options.browserVersion.trim() }
        : {}),
    }
  }

  updateProtocol(protocol: ManifestProtocol): void {
    this.browser = { ...this.browser, protocol }
  }

  async beginEntity(input: ManifestEntityInput): Promise<string> {
    if (input.scope === 'spec' && this.current) {
      return this.current.id
    }

    const spec = normalizeManifestPath(
      resolveEntitySpecPath(input),
      process.cwd(),
    )
    const testName =
      input.test?.title?.trim() ||
      input.test?.fullTitle?.trim() ||
      input.test?.fullName?.trim() ||
      'unknown test'
    const fullName =
      input.test?.fullTitle?.trim() || input.test?.fullName?.trim()
    const identityKey = `${input.scope}\0${spec}\0${fullName ?? testName}`
    const inferredAttempt = (this.attempts.get(identityKey) ?? 0) + 1
    this.attempts.set(identityKey, inferredAttempt)
    const attempt = Math.max(1, input.attempt ?? inferredAttempt)
    const startedAt = new Date().toISOString()
    const test =
      input.scope === 'test'
        ? {
            name: testName,
            ...(fullName ? { fullName } : {}),
          }
        : undefined

    const draft: ManifestEntryDraft = {
      id: randomUUID(),
      attempt,
      scope: input.scope,
      spec,
      ...(test ? { test } : {}),
      startedAt,
      cumulativeResult: 'unknown',
    }
    this.current = draft
    const interruptionCheckpoint = await this.buildEntry(
      draft,
      {
        decision: 'failed',
        result: 'unknown',
        reason: 'worker-interrupted-before-finalization',
        processingOutcome: 'failed',
        processingOperation: 'capture',
      },
      'unknown',
    )
    this.completedEntries.set(interruptionCheckpoint.id, interruptionCheckpoint)
    await this.journal.append({
      type: 'entry',
      entry: interruptionCheckpoint,
    })
    return draft.id
  }

  markCaptureStarted(): void {
    if (!this.current) {
      return
    }
    this.current.captureStartedAt ??= new Date().toISOString()
  }

  setCurrentAttempt(attempt: number): void {
    if (this.current) {
      this.current.attempt = Math.max(1, Math.floor(attempt))
    }
  }

  async recordResult(result: ManifestResult): Promise<void> {
    if (this.current) {
      this.current.cumulativeResult = combineResults(
        this.current.cumulativeResult,
        result,
      )
      return
    }
    if (!this.lastCompletedEntryId) {
      return
    }
    const existing = this.completedEntries.get(this.lastCompletedEntryId)
    if (!existing) {
      return
    }
    const completedAt = new Date().toISOString()
    const updated: ManifestEntryV1 = {
      ...existing,
      result: combineResults(existing.result, result),
      timings: {
        ...existing.timings,
        completedAt,
        durationMs: elapsedMilliseconds(
          existing.timings.startedAt,
          completedAt,
        ),
      },
    }
    this.completedEntries.set(updated.id, updated)
    await this.journal.append({ type: 'entry', entry: updated })
  }

  async completeCurrent(
    options: CompleteManifestEntryOptions,
  ): Promise<string | undefined> {
    const draft = this.current
    if (!draft) {
      return undefined
    }
    this.current = undefined
    if (draft.captureStartedAt) {
      draft.captureStoppedAt = new Date().toISOString()
    }
    const result = combineResults(draft.cumulativeResult, options.result)
    const entry = await this.buildEntry(draft, options, result)
    this.completedEntries.set(entry.id, entry)
    this.lastCompletedEntryId = entry.id
    await this.journal.append({ type: 'entry', entry })
    return entry.id
  }

  async completeDeferred(
    entryId: string,
    options: Omit<CompleteManifestEntryOptions, 'result'>,
  ): Promise<void> {
    const existing = this.completedEntries.get(entryId)
    if (!existing) {
      return
    }
    const artifacts = await this.createArtifacts(
      options.paths ?? existing.capture.segments.map((item) => item.path),
      true,
    )
    const completedAt = new Date().toISOString()
    const updated: ManifestEntryV1 = {
      ...existing,
      capture: {
        decision: options.decision,
        segments: artifacts.segments,
        ...(artifacts.final ? { final: artifacts.final } : {}),
        ...(options.reason ? { reason: options.reason } : {}),
      },
      processing: {
        timing: 'after-worker',
        outcome: options.processingOutcome ?? 'completed',
        ...(options.processingOperation
          ? { operation: options.processingOperation }
          : {}),
        ...(options.reason ? { reason: options.reason } : {}),
      },
      timings: {
        ...existing.timings,
        completedAt,
        durationMs: elapsedMilliseconds(
          existing.timings.startedAt,
          completedAt,
        ),
      },
    }
    this.completedEntries.set(entryId, updated)
    await this.journal.append({ type: 'entry', entry: updated })
  }

  async noteFfmpegVersion(version: string): Promise<void> {
    if (!version.trim()) {
      return
    }
    await this.journal.append({
      type: 'tools',
      tools: { ffmpeg: version.trim() },
    })
  }

  async flush(): Promise<void> {
    await this.journal.flush()
  }

  private async buildEntry(
    draft: ManifestEntryDraft,
    options: CompleteManifestEntryOptions,
    result: ManifestResult,
  ): Promise<ManifestEntryV1> {
    const artifacts = await this.createArtifacts(
      options.paths ?? [],
      options.processingOutcome !== 'pending',
    )
    const completedAt = new Date().toISOString()
    return {
      id: draft.id,
      runId: this.context.runId,
      cid: this.cid,
      sessionHash: this.sessionHash,
      browser: this.browser,
      framework: this.framework,
      spec: draft.spec,
      ...(draft.test ? { test: draft.test } : {}),
      scope: draft.scope,
      attempt: draft.attempt,
      result,
      capture: {
        decision: options.decision,
        segments: artifacts.segments,
        ...(artifacts.final ? { final: artifacts.final } : {}),
        ...(options.reason ? { reason: options.reason } : {}),
      },
      processing: {
        timing:
          options.processingOutcome === 'pending'
            ? 'after-worker'
            : 'after-test',
        outcome: options.processingOutcome ?? 'not-required',
        ...(options.processingOperation
          ? { operation: options.processingOperation }
          : {}),
        ...(options.reason ? { reason: options.reason } : {}),
      },
      timings: {
        startedAt: draft.startedAt,
        ...(draft.captureStartedAt
          ? { captureStartedAt: draft.captureStartedAt }
          : {}),
        ...(draft.captureStoppedAt
          ? { captureStoppedAt: draft.captureStoppedAt }
          : {}),
        ...(options.processingOutcome === 'pending'
          ? { processingStartedAt: completedAt }
          : {}),
        completedAt,
        durationMs: elapsedMilliseconds(draft.startedAt, completedAt),
      },
    }
  }

  private async createArtifacts(
    paths: string[],
    finalized: boolean,
  ): Promise<{
    segments: ManifestMediaArtifact[]
    final?: ManifestMediaArtifact
  }> {
    const artifacts = await Promise.all(
      [...new Set(paths)].map(async (filePath) => {
        const absolutePath = path.isAbsolute(filePath)
          ? filePath
          : path.resolve(this.context.outputDir, filePath)
        const size = await fs
          .stat(absolutePath)
          .then((stats) => stats.size)
          .catch(() => 0)
        // Pending deferred inputs are not final media; measure only after processing.
        const dimensions =
          finalized && size > 0
            ? await this.readDimensions?.(absolutePath)
            : undefined
        const artifact: ManifestMediaArtifact = {
          path: normalizeManifestPath(absolutePath, this.context.outputDir),
          mimeType:
            path.extname(absolutePath).toLowerCase() === '.mp4'
              ? 'video/mp4'
              : 'video/webm',
          size,
          ...(dimensions
            ? { width: dimensions.width, height: dimensions.height }
            : {}),
        }
        return artifact
      }),
    )
    const final = finalized && artifacts.length === 1 ? artifacts[0] : undefined
    return {
      segments: artifacts,
      ...(final ? { final } : {}),
    }
  }
}

const resolveEntitySpecPath = (input: ManifestEntityInput): string => {
  const observedFile = input.test?.file
  if (observedFile) {
    const normalizedObservedFile = normalizeManifestPath(
      observedFile,
      process.cwd(),
    )
    const matchingSpec = input.specPaths.find((specPath) => {
      return (
        normalizeManifestPath(specPath, process.cwd()) ===
        normalizedObservedFile
      )
    })
    if (matchingSpec) {
      return matchingSpec
    }
  }
  if (input.specPaths.length === 1) {
    return input.specPaths[0] ?? 'unknown-spec'
  }
  return observedFile ?? input.specPaths[0] ?? 'unknown-spec'
}

const combineResults = (
  current: ManifestResult,
  next: ManifestResult,
): ManifestResult => {
  if (current === 'failed' || next === 'failed') {
    return 'failed'
  }
  if (current === 'passed' || next === 'passed') {
    return 'passed'
  }
  if (current === 'skipped' || next === 'skipped') {
    return 'skipped'
  }
  return 'unknown'
}

const elapsedMilliseconds = (
  startedAt: string,
  completedAt: string,
): number => {
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
}
