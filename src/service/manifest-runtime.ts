import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { Frameworks } from '@wdio/types'
import {
  MANIFEST_SCHEMA_VERSION,
  type ManifestBrowser,
  type ManifestCaptureDecision,
  type ManifestDiagnostic,
  type ManifestEntryV1,
  type ManifestFramework,
  type ManifestMediaArtifact,
  type ManifestProcessingOutcome,
  type ManifestProtocol,
  type ManifestRecordingScope,
  type ManifestResult,
  type ManifestRunV1,
  type ManifestToolVersions,
  type VideoManifestV1,
  validateVideoManifest,
} from '../manifest.js'
import { nodeProcess } from './boundaries.js'

const require = createRequire(import.meta.url)
const MANIFEST_WORK_DIR = '.wdio-video-manifest'
const MANIFEST_FILE = 'manifest.json'
const MANIFEST_LOCK_FILE = '.wdio-video-manifest.lock'
const MANIFEST_LOCK_TIMEOUT_MS = 30_000
const MANIFEST_LOCK_STALE_MS = 120_000
const MANIFEST_LOCK_POLL_MS = 25
const ignoreFileError = (): undefined => undefined

interface ManifestLockMetadata {
  createdAt: number
  ownerId?: string
  pid: number
}

export const MANIFEST_RUN_CONFIG_KEY =
  'wdioPuppeteerVideoServiceManifestRun' as const
export const MANIFEST_WORKER_CONFIG_KEY =
  'wdioPuppeteerVideoServiceManifestWorker' as const

export interface ManifestRunContext {
  runId: string
  outputDir: string
  startedAt: string
  tools: ManifestToolVersions
}

export interface ManifestWorkerContext {
  specFileRetryAttempt: number
}

interface ManifestWorkerContextEnvelope {
  contexts: Record<string, ManifestWorkerContext>
  version: 1
}

export interface ManifestCaptureDimensions {
  width: number
  height: number
}

export interface ManifestEntityInput {
  test?: Partial<
    Pick<Frameworks.Test, 'file' | 'fullName' | 'fullTitle' | 'title'>
  >
  scope: ManifestRecordingScope
  specPaths: string[]
  attempt?: number
}

export interface CompleteManifestEntryOptions {
  decision: ManifestCaptureDecision
  result: ManifestResult
  paths?: string[]
  reason?: string
  processingOutcome?: ManifestProcessingOutcome
  processingOperation?: 'capture' | 'merge' | 'transcode'
}

interface ManifestEntryDraft {
  id: string
  attempt: number
  scope: ManifestRecordingScope
  spec: string
  test?: { name: string; fullName?: string }
  startedAt: string
  captureStartedAt?: string
  captureStoppedAt?: string
  dimensions?: ManifestCaptureDimensions
  cumulativeResult: ManifestResult
}

interface ManifestJournalEntryEvent {
  type: 'entry'
  entry: ManifestEntryV1
}

interface ManifestJournalToolsEvent {
  type: 'tools'
  tools: Partial<ManifestToolVersions>
}

type ManifestJournalEvent =
  | ManifestJournalEntryEvent
  | ManifestJournalToolsEvent

interface ParsedJournals {
  diagnostics: ManifestDiagnostic[]
  entries: ManifestEntryV1[]
  tools: Partial<ManifestToolVersions>
}

export const createManifestRunContext = async (
  outputDir: string,
): Promise<ManifestRunContext> => {
  const context: ManifestRunContext = {
    runId: randomUUID(),
    outputDir: path.resolve(outputDir),
    startedAt: new Date().toISOString(),
    tools: {
      service: readPackageVersion('wdio-puppeteer-video-service'),
      node: process.version,
      webdriverio: readPackageVersion('webdriverio'),
      puppeteer: readPackageVersion('puppeteer-core'),
    },
  }
  await fs.mkdir(getJournalDir(context), { recursive: true })
  return context
}

export const assignManifestRunContext = (
  config: object,
  context: ManifestRunContext,
): void => {
  Object.assign(config, { [MANIFEST_RUN_CONFIG_KEY]: context })
}

export const assignManifestWorkerContext = (
  config: object,
  cid: string,
  context: ManifestWorkerContext,
): void => {
  const existing = readManifestWorkerContextEnvelope(config)
  Object.assign(config, {
    [MANIFEST_WORKER_CONFIG_KEY]: {
      contexts: {
        ...existing?.contexts,
        [cid]: context,
      },
      version: 1,
    } satisfies ManifestWorkerContextEnvelope,
  })
}

export const readManifestRunContext = (
  config: unknown,
): ManifestRunContext | undefined => {
  if (!config || typeof config !== 'object') {
    return undefined
  }
  const value = (config as Record<string, unknown>)[MANIFEST_RUN_CONFIG_KEY]
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const context = value as Record<string, unknown>
  if (
    !isNonEmptyString(context.runId) ||
    !isNonEmptyString(context.outputDir) ||
    !path.isAbsolute(context.outputDir) ||
    !isNonEmptyString(context.startedAt) ||
    !Number.isFinite(Date.parse(context.startedAt)) ||
    !isManifestToolVersions(context.tools)
  ) {
    return undefined
  }
  return {
    runId: context.runId,
    outputDir: context.outputDir,
    startedAt: context.startedAt,
    tools: context.tools,
  }
}

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.trim().length > 0
}

const isManifestToolVersions = (
  value: unknown,
): value is ManifestToolVersions => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const tools = value as Record<string, unknown>
  return (
    isNonEmptyString(tools.service) &&
    isNonEmptyString(tools.node) &&
    isNonEmptyString(tools.webdriverio) &&
    isNonEmptyString(tools.puppeteer) &&
    (tools.ffmpeg === undefined || isNonEmptyString(tools.ffmpeg))
  )
}

export const readManifestWorkerContext = (
  config: unknown,
  cid: string,
): ManifestWorkerContext | undefined => {
  return readManifestWorkerContextEnvelope(config)?.contexts[cid]
}

export const hasManifestWorkerContexts = (config: unknown): boolean => {
  const envelope = readManifestWorkerContextEnvelope(config)
  return envelope !== undefined && Object.keys(envelope.contexts).length > 0
}

const readManifestWorkerContextEnvelope = (
  config: unknown,
): ManifestWorkerContextEnvelope | undefined => {
  if (!config || typeof config !== 'object') {
    return undefined
  }
  const value = (config as Record<string, unknown>)[MANIFEST_WORKER_CONFIG_KEY]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const envelope = value as Partial<ManifestWorkerContextEnvelope>
  if (
    envelope.version !== 1 ||
    !envelope.contexts ||
    typeof envelope.contexts !== 'object' ||
    Array.isArray(envelope.contexts)
  ) {
    return undefined
  }

  const contexts = envelope.contexts as Record<string, unknown>
  for (const [cid, contextValue] of Object.entries(contexts)) {
    if (!cid || !isManifestWorkerContext(contextValue)) {
      return undefined
    }
  }
  return envelope as ManifestWorkerContextEnvelope
}

const isManifestWorkerContext = (
  value: unknown,
): value is ManifestWorkerContext => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const attempt = (value as Partial<ManifestWorkerContext>).specFileRetryAttempt
  return Number.isInteger(attempt) && (attempt ?? -1) >= 0
}

export class ManifestWorkerRecorder {
  private readonly _context: ManifestRunContext
  private readonly _cid: string
  private readonly _framework: ManifestFramework
  private readonly _journalPath: string
  private readonly _attempts = new Map<string, number>()
  private readonly _completedEntries = new Map<string, ManifestEntryV1>()
  private _browser: ManifestBrowser = {
    name: 'unknown',
    protocol: 'unsupported',
  }
  private _sessionHash = hashPrivateValue('unavailable', 'unavailable')
  private _current: ManifestEntryDraft | undefined
  private _lastCompletedEntryId: string | undefined
  private _writeTask: Promise<void> = Promise.resolve()
  private readonly _failurePolicy: 'error' | 'warn'
  private readonly _onJournalError: (operation: string, error: unknown) => void

  constructor(options: {
    context: ManifestRunContext
    cid: string
    framework: ManifestFramework
    failurePolicy?: 'error' | 'warn'
    onJournalError?: (operation: string, error: unknown) => void
  }) {
    this._context = options.context
    this._cid = options.cid
    this._framework = options.framework
    this._failurePolicy = options.failurePolicy ?? 'warn'
    this._onJournalError = options.onJournalError ?? (() => undefined)
    this._journalPath = path.join(
      getJournalDir(options.context),
      `${sanitizeJournalToken(options.cid)}-${process.pid.toString()}.jsonl`,
    )
  }

  get currentEntryId(): string | undefined {
    return this._current?.id
  }

  configureSession(options: {
    sessionId: string
    browserName?: string
    browserVersion?: string
    protocol: ManifestProtocol
  }): void {
    this._sessionHash = hashPrivateValue(this._context.runId, options.sessionId)
    this._browser = {
      name: options.browserName?.trim() || 'unknown',
      protocol: options.protocol,
      ...(options.browserVersion?.trim()
        ? { version: options.browserVersion.trim() }
        : {}),
    }
  }

  updateProtocol(protocol: ManifestProtocol): void {
    this._browser = { ...this._browser, protocol }
  }

  async beginEntity(input: ManifestEntityInput): Promise<string> {
    if (input.scope === 'spec' && this._current) {
      return this._current.id
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
    const identityKey = `${input.scope}\0${spec}\0${testName}`
    const inferredAttempt = (this._attempts.get(identityKey) ?? 0) + 1
    this._attempts.set(identityKey, inferredAttempt)
    const attempt = Math.max(1, input.attempt ?? inferredAttempt)
    const startedAt = new Date().toISOString()
    const fullName =
      input.test?.fullTitle?.trim() || input.test?.fullName?.trim()
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
    this._current = draft
    const interruptionCheckpoint = await this._buildEntry(
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
    this._completedEntries.set(
      interruptionCheckpoint.id,
      interruptionCheckpoint,
    )
    await this._append({ type: 'entry', entry: interruptionCheckpoint })
    return draft.id
  }

  markCaptureStarted(dimensions?: ManifestCaptureDimensions): void {
    if (!this._current) {
      return
    }
    this._current.captureStartedAt ??= new Date().toISOString()
    if (dimensions) {
      this._current.dimensions = dimensions
    }
  }

  setCurrentAttempt(attempt: number): void {
    if (this._current) {
      this._current.attempt = Math.max(1, Math.floor(attempt))
    }
  }

  async recordResult(result: ManifestResult): Promise<void> {
    if (this._current) {
      this._current.cumulativeResult = combineResults(
        this._current.cumulativeResult,
        result,
      )
      return
    }
    if (!this._lastCompletedEntryId) {
      return
    }
    const existing = this._completedEntries.get(this._lastCompletedEntryId)
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
    this._completedEntries.set(updated.id, updated)
    await this._append({ type: 'entry', entry: updated })
  }

  async completeCurrent(
    options: CompleteManifestEntryOptions,
  ): Promise<string | undefined> {
    const draft = this._current
    if (!draft) {
      return undefined
    }
    this._current = undefined
    if (draft.captureStartedAt) {
      draft.captureStoppedAt = new Date().toISOString()
    }
    const result = combineResults(draft.cumulativeResult, options.result)
    const entry = await this._buildEntry(draft, options, result)
    this._completedEntries.set(entry.id, entry)
    this._lastCompletedEntryId = entry.id
    await this._append({ type: 'entry', entry })
    return entry.id
  }

  async completeDeferred(
    entryId: string,
    options: Omit<CompleteManifestEntryOptions, 'result'>,
  ): Promise<void> {
    const existing = this._completedEntries.get(entryId)
    if (!existing) {
      return
    }
    const artifacts = await this._createArtifacts(
      options.paths ?? existing.capture.segments.map((item) => item.path),
      undefined,
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
    this._completedEntries.set(entryId, updated)
    await this._append({ type: 'entry', entry: updated })
  }

  async noteFfmpegVersion(version: string): Promise<void> {
    if (!version.trim()) {
      return
    }
    await this._append({ type: 'tools', tools: { ffmpeg: version.trim() } })
  }

  async flush(): Promise<void> {
    await this._writeTask
  }

  private async _buildEntry(
    draft: ManifestEntryDraft,
    options: CompleteManifestEntryOptions,
    result: ManifestResult,
  ): Promise<ManifestEntryV1> {
    const artifacts = await this._createArtifacts(
      options.paths ?? [],
      draft.dimensions,
      options.processingOutcome !== 'pending',
    )
    const completedAt = new Date().toISOString()
    return {
      id: draft.id,
      runId: this._context.runId,
      cid: this._cid,
      sessionHash: this._sessionHash,
      browser: this._browser,
      framework: this._framework,
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

  private async _createArtifacts(
    paths: string[],
    dimensions: ManifestCaptureDimensions | undefined,
    selectFinal: boolean,
  ): Promise<{
    segments: ManifestMediaArtifact[]
    final?: ManifestMediaArtifact
  }> {
    const artifacts = await Promise.all(
      [...new Set(paths)].map(async (filePath) => {
        const absolutePath = path.isAbsolute(filePath)
          ? filePath
          : path.resolve(this._context.outputDir, filePath)
        const size = await fs
          .stat(absolutePath)
          .then((stats) => stats.size)
          .catch(() => 0)
        const artifact: ManifestMediaArtifact = {
          path: normalizeManifestPath(absolutePath, this._context.outputDir),
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
    const final =
      selectFinal && artifacts.length === 1 ? artifacts[0] : undefined
    return {
      segments: artifacts,
      ...(final ? { final } : {}),
    }
  }

  private async _append(event: ManifestJournalEvent): Promise<void> {
    const write = async (): Promise<void> => {
      await fs.mkdir(path.dirname(this._journalPath), { recursive: true })
      await fs.appendFile(
        this._journalPath,
        `${JSON.stringify(event)}\n`,
        'utf8',
      )
    }
    const writeTask = this._writeTask.then(write, write)
    this._writeTask = writeTask
    try {
      await writeTask
    } catch (error) {
      if (this._writeTask === writeTask) {
        this._writeTask = Promise.resolve()
      }
      this._onJournalError('write the worker manifest journal', error)
      if (this._failurePolicy === 'error') {
        throw error
      }
    }
  }
}

export const aggregateManifestRun = async (
  context: ManifestRunContext,
  exitCode: number,
): Promise<VideoManifestV1> => {
  const parsed = await parseJournals(context)
  const completedAt = new Date().toISOString()
  const run: ManifestRunV1 = {
    id: context.runId,
    startedAt: context.startedAt,
    completedAt,
    exitCode,
    tools: { ...context.tools, ...parsed.tools },
    entries: parsed.entries,
    ...(parsed.diagnostics.length > 0
      ? { diagnostics: parsed.diagnostics }
      : {}),
  }
  const release = await acquireManifestLock(context.outputDir)
  let temporaryPath: string | undefined
  try {
    const manifestPath = path.join(context.outputDir, MANIFEST_FILE)
    const existing = await readExistingManifest(manifestPath)
    const manifest: VideoManifestV1 = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      generatedAt: completedAt,
      runs: [
        ...existing.runs.filter((existingRun) => existingRun.id !== run.id),
        run,
      ],
    }
    temporaryPath = path.join(
      context.outputDir,
      `.manifest-${process.pid.toString()}-${randomUUID()}.tmp`,
    )
    await fs.mkdir(context.outputDir, { recursive: true })
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(manifest, undefined, 2)}\n`,
      'utf8',
    )
    await fs.rename(temporaryPath, manifestPath)
    temporaryPath = undefined
    await fs.rm(getRunDir(context), { recursive: true, force: true })
    await fs
      .rmdir(path.join(context.outputDir, MANIFEST_WORK_DIR))
      .catch(ignoreFileError)
    return manifest
  } finally {
    if (temporaryPath) {
      await fs.unlink(temporaryPath).catch(ignoreFileError)
    }
    await release()
  }
}

export const normalizeManifestPath = (
  filePath: string,
  baseDir: string,
): string => {
  const resolvedBase = path.resolve(baseDir)
  const resolvedPath = path.resolve(
    filePath.startsWith('file:') ? fileURLToPath(filePath) : filePath,
  )
  const relative = path.relative(resolvedBase, resolvedPath)
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return sanitizePathComponent(path.basename(resolvedPath) || 'unknown')
  }
  return relative.split(path.sep).map(sanitizePathComponent).join('/')
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

export const hashPrivateValue = (salt: string, value: string): string => {
  return createHash('sha256')
    .update(salt)
    .update('\0')
    .update(value)
    .digest('hex')
}

export const normalizeManifestFramework = (
  value: unknown,
): ManifestFramework => {
  return value === 'mocha' || value === 'jasmine' || value === 'cucumber'
    ? value
    : 'unknown'
}

const parseJournals = async (
  context: ManifestRunContext,
): Promise<ParsedJournals> => {
  const journalDir = getJournalDir(context)
  const journalNames = await fs.readdir(journalDir).catch(() => [] as string[])
  const entries = new Map<string, ManifestEntryV1>()
  const diagnostics: ManifestDiagnostic[] = []
  const tools: Partial<ManifestToolVersions> = {}

  for (const journalName of journalNames.toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    if (!journalName.endsWith('.jsonl')) {
      continue
    }
    await collectJournalFile(
      path.join(journalDir, journalName),
      context,
      entries,
      diagnostics,
      tools,
    )
  }

  return {
    diagnostics,
    entries: [...entries.values()].sort((left, right) =>
      left.timings.startedAt.localeCompare(right.timings.startedAt),
    ),
    tools,
  }
}

const collectJournalFile = async (
  journalPath: string,
  context: ManifestRunContext,
  entries: Map<string, ManifestEntryV1>,
  diagnostics: ManifestDiagnostic[],
  tools: Partial<ManifestToolVersions>,
): Promise<void> => {
  const content = await fs.readFile(journalPath, 'utf8')
  const lines = content.split('\n')
  const lastNonEmptyIndex = lines.findLastIndex(
    (line) => line.trim().length > 0,
  )
  for (const [index, line] of lines.entries()) {
    collectJournalLine({
      context,
      diagnostics,
      entries,
      index,
      journalPath,
      lastNonEmptyIndex,
      line,
      tools,
    })
  }
}

const collectJournalLine = (options: {
  context: ManifestRunContext
  diagnostics: ManifestDiagnostic[]
  entries: Map<string, ManifestEntryV1>
  index: number
  journalPath: string
  lastNonEmptyIndex: number
  line: string
  tools: Partial<ManifestToolVersions>
}): void => {
  if (!options.line.trim()) {
    return
  }
  const event = parseJournalEvent(options.line)
  if (!event) {
    options.diagnostics.push({
      code:
        options.index === options.lastNonEmptyIndex
          ? 'malformed-final-journal-line'
          : 'invalid-journal-entry',
      journal: normalizeManifestPath(
        options.journalPath,
        options.context.outputDir,
      ),
      line: options.index + 1,
    })
    return
  }
  if (event.type === 'tools') {
    Object.assign(options.tools, event.tools)
    return
  }
  if (isValidManifestEntry(event.entry, options.context)) {
    options.entries.set(event.entry.id, event.entry)
    return
  }
  options.diagnostics.push({
    code: 'invalid-journal-entry',
    journal: normalizeManifestPath(
      options.journalPath,
      options.context.outputDir,
    ),
    line: options.index + 1,
  })
}

const parseJournalEvent = (line: string): ManifestJournalEvent | undefined => {
  try {
    const value = JSON.parse(line) as unknown
    if (!value || typeof value !== 'object') {
      return undefined
    }
    const event = value as Partial<ManifestJournalEvent>
    if (event.type === 'entry' && event.entry) {
      return event as ManifestJournalEntryEvent
    }
    if (event.type === 'tools' && event.tools) {
      return event as ManifestJournalToolsEvent
    }
  } catch {
    return undefined
  }
  return undefined
}

const isValidManifestEntry = (
  entry: ManifestEntryV1,
  context: ManifestRunContext,
): boolean => {
  const now = new Date().toISOString()
  return (
    entry.runId === context.runId &&
    validateVideoManifest({
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      generatedAt: now,
      runs: [
        {
          id: context.runId,
          startedAt: context.startedAt,
          completedAt: now,
          exitCode: 0,
          tools: context.tools,
          entries: [entry],
        },
      ],
    }).valid
  )
}

const readExistingManifest = async (
  manifestPath: string,
): Promise<VideoManifestV1> => {
  const value = await fs
    .readFile(manifestPath, 'utf8')
    .then((content) => JSON.parse(content) as unknown)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return undefined
      }
      throw error
    })
  if (value === undefined) {
    return {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      generatedAt: new Date(0).toISOString(),
      runs: [],
    }
  }
  const validation = validateVideoManifest(value)
  if (!validation.valid) {
    throw new Error(
      `Existing manifest.json is invalid: ${validation.errors.join('; ')}`,
    )
  }
  return value as VideoManifestV1
}

const acquireManifestLock = async (
  outputDir: string,
): Promise<() => Promise<void>> => {
  await fs.mkdir(outputDir, { recursive: true })
  const lockPath = path.join(outputDir, MANIFEST_LOCK_FILE)
  const deadline = Date.now() + MANIFEST_LOCK_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const handle = await fs.open(lockPath, 'wx')
      const ownerId = randomUUID()
      try {
        await handle.writeFile(
          JSON.stringify({
            ownerId,
            pid: nodeProcess.pid,
            createdAt: Date.now(),
          }),
          'utf8',
        )
      } catch (error) {
        await handle.close().catch(ignoreFileError)
        await fs.unlink(lockPath).catch(ignoreFileError)
        throw error
      }
      await handle.close()
      return async () => {
        const metadata = await readManifestLockMetadata(lockPath)
        if (metadata?.ownerId === ownerId) {
          await fs.unlink(lockPath).catch(ignoreFileError)
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
      if (await cleanupStaleManifestLock(lockPath)) {
        continue
      }
      await delay(MANIFEST_LOCK_POLL_MS)
    }
  }
  throw new Error(`Timed out waiting for manifest lock: ${lockPath}`)
}

const readManifestLockMetadata = async (
  lockPath: string,
): Promise<ManifestLockMetadata | undefined> => {
  try {
    const value = JSON.parse(
      await fs.readFile(lockPath, 'utf8'),
    ) as Partial<ManifestLockMetadata>
    if (
      typeof value.createdAt !== 'number' ||
      !Number.isFinite(value.createdAt) ||
      (value.ownerId !== undefined &&
        (typeof value.ownerId !== 'string' || !value.ownerId)) ||
      typeof value.pid !== 'number' ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0
    ) {
      return undefined
    }
    return value as ManifestLockMetadata
  } catch {
    return undefined
  }
}

const cleanupStaleManifestLock = async (lockPath: string): Promise<boolean> => {
  const [contents, stats] = await Promise.all([
    fs.readFile(lockPath, 'utf8').catch(ignoreFileError),
    fs.stat(lockPath).catch(ignoreFileError),
  ])
  if (contents === undefined || !stats) {
    return true
  }
  const metadata = await readManifestLockMetadata(lockPath)
  const stale = metadata
    ? !nodeProcess.isAlive(metadata.pid)
    : Date.now() - stats.mtimeMs > MANIFEST_LOCK_STALE_MS
  if (!stale) {
    return false
  }

  const [currentContents, currentStats] = await Promise.all([
    fs.readFile(lockPath, 'utf8').catch(ignoreFileError),
    fs.stat(lockPath).catch(ignoreFileError),
  ])
  if (
    currentContents !== contents ||
    currentStats?.ino !== stats.ino ||
    currentStats?.mtimeMs !== stats.mtimeMs
  ) {
    return false
  }
  await fs.unlink(lockPath).catch(ignoreFileError)
  return !(await fs.stat(lockPath).catch(ignoreFileError))
}

const readPackageVersion = (packageName: string): string => {
  if (packageName === 'wdio-puppeteer-video-service') {
    const packagePath = path.resolve(import.meta.dirname, '../../package.json')
    return readPackageVersionFile(packagePath)
  }
  try {
    return readPackageVersionFile(
      require.resolve(`${packageName}/package.json`),
    )
  } catch {
    try {
      const entryDirectory = path.dirname(require.resolve(packageName))
      const directParentVersion = readPackageVersionFile(
        path.resolve(entryDirectory, '../package.json'),
      )
      if (directParentVersion !== 'unknown') {
        return directParentVersion
      }
      return readPackageVersionFile(
        path.resolve(entryDirectory, '../../package.json'),
      )
    } catch {
      return 'unknown'
    }
  }
}

const readPackageVersionFile = (packagePath: string): string => {
  try {
    const packageJson = require(packagePath) as { version?: unknown }
    return typeof packageJson.version === 'string'
      ? packageJson.version
      : 'unknown'
  } catch {
    return 'unknown'
  }
}

const getRunDir = (context: ManifestRunContext): string => {
  return path.join(context.outputDir, MANIFEST_WORK_DIR, context.runId)
}

const getJournalDir = (context: ManifestRunContext): string => {
  return path.join(getRunDir(context), 'journals')
}

const sanitizeJournalToken = (value: string): string => {
  const sanitized = value.replace(/[^a-z0-9_-]+/giu, '_')
  return sanitized || 'worker'
}

const sanitizePathComponent = (value: string): string => {
  let sanitized = ''
  for (const character of value) {
    sanitized += (character.codePointAt(0) ?? 0) <= 31 ? '_' : character
  }
  return sanitized || 'unknown'
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
