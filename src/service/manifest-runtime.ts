import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Frameworks } from '@wdio/types'
import type {
  ManifestBrowser,
  ManifestCapture,
  ManifestCaptureDecision,
  ManifestEntryV1,
  ManifestFinalArtifact,
  ManifestFramework,
  ManifestProcessingOutcome,
  ManifestProtocol,
  ManifestRecordingScope,
  ManifestResult,
  ManifestSegmentArtifact,
  ManifestTab,
} from '../manifest.js'
import type { SegmentTab } from './capture-session.js'
import type { ManifestRunContext } from './manifest-context.js'
import {
  createManifestJournalPath,
  ManifestJournalWriter,
} from './manifest-journal.js'
import { hashPrivateValue, normalizeManifestPath } from './manifest-paths.js'
import type { MediaDimensions } from './media-metadata.js'
import { extractPartNumber } from './paths.js'

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
  /** Filesystem paths, absolute or relative to the worker's working directory. */
  readonly paths?: string[]
  readonly reason?: string
  readonly processingOutcome?: ManifestProcessingOutcome
  readonly processingOperation?: 'capture' | 'merge' | 'transcode'
  /** Tabs of the retained segments, keyed by part number. */
  readonly tabs?: ReadonlyMap<number, SegmentTab>
}

export interface CompleteDeferredManifestOptions
  extends Omit<CompleteManifestEntryOptions, 'result' | 'tabs'> {
  /**
   * The entry's paths this result supersedes; its other paths stay listed.
   * Without it, `paths` replaces the entry's whole list.
   */
  readonly replaces?: readonly string[]
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
  // Deferred tasks each entry still waits for.
  private readonly outstandingTasks = new Map<string, number>()
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

    const draft = this.createDraft(input)
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

  /**
   * Writes a whole skipped entry in one step, apart from the current entity.
   * Tests that run at the same time can each record one this way.
   */
  async recordSkippedEntity(
    input: ManifestEntityInput,
    options: { readonly reason: string; readonly result: ManifestResult },
  ): Promise<string> {
    const entry = await this.buildEntry(
      this.createDraft(input),
      {
        decision: 'skipped',
        result: options.result,
        reason: options.reason,
        processingOutcome: 'skipped',
      },
      options.result,
    )
    this.completedEntries.set(entry.id, entry)
    await this.journal.append({ type: 'entry', entry })
    return entry.id
  }

  private createDraft(input: ManifestEntityInput): ManifestEntryDraft {
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

    return {
      id: randomUUID(),
      attempt,
      scope: input.scope,
      spec,
      ...(test ? { test } : {}),
      startedAt,
      cumulativeResult: 'unknown',
    }
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

  /**
   * Registers deferred tasks for an entry. Until the last of them completes,
   * a successful result leaves the entry's processing `pending`.
   */
  expectDeferredTasks(entryId: string, count: number): void {
    if (count > 0 && this.completedEntries.has(entryId)) {
      this.outstandingTasks.set(
        entryId,
        (this.outstandingTasks.get(entryId) ?? 0) + count,
      )
    }
  }

  async completeDeferred(
    entryId: string,
    options: CompleteDeferredManifestOptions,
  ): Promise<void> {
    const pending = this.completedEntries.get(entryId)
    if (!pending) {
      return
    }
    const measured = await this.measureArtifacts(
      options.paths ??
        pending.capture.segments.map((item) =>
          path.resolve(this.context.outputDir, item.path),
        ),
      true,
    )
    // Completions for one entry can overlap, so the result is merged into the
    // entry as it is now, without another await before it is stored.
    const existing = this.completedEntries.get(entryId) ?? pending
    const outstanding = (this.outstandingTasks.get(entryId) ?? 1) - 1
    if (outstanding > 0) {
      this.outstandingTasks.set(entryId, outstanding)
    } else {
      this.outstandingTasks.delete(entryId)
    }
    const tabs = readTabHistory(existing.capture)
    const produced = attachTabs(measured, tabs)
    const segments = options.replaces
      ? this.replaceSegments(
          existing.capture.segments,
          options.replaces,
          produced,
        )
      : produced
    const final = selectFinal(segments, true)
    // Segments of one entry can finish processing separately, so an earlier
    // segment's failure stays recorded when a later one succeeds, and a
    // success leaves the entry pending while other tasks remain.
    const outcome =
      options.replaces && existing.processing.outcome === 'failed'
        ? {
            decision: existing.capture.decision,
            processingOutcome: existing.processing.outcome,
            processingOperation: existing.processing.operation,
            reason: existing.processing.reason,
          }
        : {
            ...options,
            processingOutcome:
              outstanding > 0 && options.processingOutcome !== 'failed'
                ? ('pending' as const)
                : options.processingOutcome,
          }
    const completedAt = new Date().toISOString()
    const updated: ManifestEntryV1 = {
      ...existing,
      capture: {
        decision: outcome.decision,
        segments,
        ...(final ? { final } : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      },
      processing: {
        timing: 'after-worker',
        outcome: outcome.processingOutcome ?? 'completed',
        ...(outcome.processingOperation
          ? { operation: outcome.processingOperation }
          : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {}),
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
    const finalized = options.processingOutcome !== 'pending'
    const segments = attachTabs(
      await this.measureArtifacts(options.paths ?? [], finalized),
      createTabHistory(this.hashTabs(options.tabs)),
    )
    const final = selectFinal(segments, finalized)
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
        segments,
        ...(final ? { final } : {}),
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

  private hashTabs(
    tabs: ReadonlyMap<number, SegmentTab> | undefined,
  ): Map<number, ManifestTab> {
    const hashed = new Map<number, ManifestTab>()
    for (const [part, tab] of tabs ?? []) {
      hashed.set(part, {
        ordinal: tab.ordinal,
        reason: tab.reason,
        contextHash: hashPrivateValue(this.context.runId, tab.contextId),
      })
    }
    return hashed
  }

  /** Lists `produced` where the first replaced segment was listed. */
  private replaceSegments(
    segments: readonly ManifestSegmentArtifact[],
    replaces: readonly string[],
    produced: readonly ManifestSegmentArtifact[],
  ): ManifestSegmentArtifact[] {
    const replaced = new Set(
      replaces.map((filePath) =>
        normalizeManifestPath(path.resolve(filePath), this.context.outputDir),
      ),
    )
    const producedPaths = new Set(produced.map((item) => item.path))
    const next: ManifestSegmentArtifact[] = []
    let inserted = false
    for (const segment of segments) {
      if (replaced.has(segment.path)) {
        if (!inserted) {
          next.push(...produced)
          inserted = true
        }
      } else if (!producedPaths.has(segment.path)) {
        next.push(segment)
      }
    }
    if (!inserted) {
      next.push(...produced)
    }
    return next
  }

  private async measureArtifacts(
    paths: readonly string[],
    finalized: boolean,
  ): Promise<ManifestSegmentArtifact[]> {
    return Promise.all(
      [...new Set(paths)].map(async (filePath) => {
        // Capture/processing paths already include outputDir; only persisted
        // manifest paths are relative to the manifest's directory.
        const absolutePath = path.resolve(filePath)
        const size = await fs
          .stat(absolutePath)
          .then((stats) => stats.size)
          .catch(() => 0)
        // Pending deferred inputs are not final media; measure only after processing.
        const dimensions =
          finalized && size > 0
            ? await this.readDimensions?.(absolutePath)
            : undefined
        const artifact: ManifestSegmentArtifact = {
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
  }
}

interface TabHistory {
  /** Each part file's tab, by part number. */
  readonly parts: ReadonlyMap<number, ManifestTab>
  /** The tabs a merged file holds, in part order. */
  readonly merged: readonly ManifestTab[]
}

const createTabHistory = (
  parts: ReadonlyMap<number, ManifestTab>,
  merged?: readonly ManifestTab[],
): TabHistory => ({
  parts,
  merged:
    parts.size > 0
      ? [...parts.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, tab]) => tab)
      : (merged ?? []),
})

/** Rebuilds the tab history a completed or pending entry recorded. */
const readTabHistory = (capture: ManifestCapture): TabHistory => {
  const parts = new Map<number, ManifestTab>()
  let merged: readonly ManifestTab[] | undefined
  for (const segment of capture.segments) {
    if (segment.tab) {
      parts.set(extractPartNumber(segment.path), segment.tab)
    }
    merged ??= segment.tabs
  }
  return createTabHistory(parts, merged ?? capture.final?.tabs)
}

// Part files are named `slug_partN`; a merged file is `slug` and holds them all.
const isMergedFile = (filePath: string): boolean =>
  extractPartNumber(filePath) === Number.MAX_SAFE_INTEGER

const attachTabs = (
  artifacts: readonly ManifestSegmentArtifact[],
  history: TabHistory,
): ManifestSegmentArtifact[] =>
  artifacts.map((artifact) => {
    if (isMergedFile(artifact.path)) {
      return history.merged.length > 0
        ? { ...artifact, tabs: [...history.merged] }
        : artifact
    }
    const tab = history.parts.get(extractPartNumber(artifact.path))
    return tab ? { ...artifact, tab } : artifact
  })

/** The one finalized file, with the tabs it holds. */
const selectFinal = (
  segments: readonly ManifestSegmentArtifact[],
  finalized: boolean,
): ManifestFinalArtifact | undefined => {
  const [only] = segments
  if (!finalized || !only || segments.length !== 1) {
    return undefined
  }
  const { tab, tabs, ...final } = only
  const finalTabs = tabs ?? (tab ? [tab] : [])
  return finalTabs.length > 0 ? { ...final, tabs: finalTabs } : final
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
