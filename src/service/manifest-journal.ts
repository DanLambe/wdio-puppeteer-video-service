import fs from 'node:fs/promises'
import path from 'node:path'
import {
  MANIFEST_SCHEMA_VERSION,
  type ManifestDiagnostic,
  type ManifestEntryV1,
  type ManifestToolVersions,
  validateVideoManifest,
} from '../manifest.js'
import type { ManifestRunContext } from './manifest-context.js'
import { normalizeManifestPath } from './manifest-paths.js'

export const MANIFEST_WORK_DIRECTORY = '.wdio-video-manifest'

export interface ManifestJournalEntryEvent {
  readonly type: 'entry'
  readonly entry: ManifestEntryV1
}

export interface ManifestJournalToolsEvent {
  readonly type: 'tools'
  readonly tools: Partial<ManifestToolVersions>
}

export type ManifestJournalEvent =
  | ManifestJournalEntryEvent
  | ManifestJournalToolsEvent

export interface ParsedManifestJournals {
  readonly diagnostics: ManifestDiagnostic[]
  readonly entries: ManifestEntryV1[]
  readonly tools: Partial<ManifestToolVersions>
}

export class ManifestJournalWriter {
  private readonly failurePolicy: 'error' | 'warn'
  private readonly journalPath: string
  private readonly onError: (operation: string, error: unknown) => void
  private writeTask: Promise<void> = Promise.resolve()

  constructor(options: {
    readonly failurePolicy: 'error' | 'warn'
    readonly journalPath: string
    readonly onError: (operation: string, error: unknown) => void
  }) {
    this.failurePolicy = options.failurePolicy
    this.journalPath = options.journalPath
    this.onError = options.onError
  }

  async append(event: ManifestJournalEvent): Promise<void> {
    const write = async (): Promise<void> => {
      await fs.mkdir(path.dirname(this.journalPath), { recursive: true })
      await fs.appendFile(
        this.journalPath,
        `${JSON.stringify(event)}\n`,
        'utf8',
      )
    }
    const writeTask = this.writeTask.then(write, write)
    this.writeTask = writeTask
    try {
      await writeTask
    } catch (error) {
      if (this.writeTask === writeTask) {
        this.writeTask = Promise.resolve()
      }
      this.onError('write the worker manifest journal', error)
      if (this.failurePolicy === 'error') {
        throw error
      }
    }
  }

  async flush(): Promise<void> {
    await this.writeTask
  }
}

export const getManifestRunDirectory = (
  context: ManifestRunContext,
): string => {
  return path.join(context.outputDir, MANIFEST_WORK_DIRECTORY, context.runId)
}

export const getManifestJournalDirectory = (
  context: ManifestRunContext,
): string => {
  return path.join(getManifestRunDirectory(context), 'journals')
}

export const createManifestJournalPath = (
  context: ManifestRunContext,
  cid: string,
): string => {
  return path.join(
    getManifestJournalDirectory(context),
    `${sanitizeJournalToken(cid)}-${process.pid.toString()}.jsonl`,
  )
}

export const parseManifestJournals = async (
  context: ManifestRunContext,
): Promise<ParsedManifestJournals> => {
  const journalDirectory = getManifestJournalDirectory(context)
  const journalNames = await fs
    .readdir(journalDirectory)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return [] as string[]
      }
      throw error
    })
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
      path.join(journalDirectory, journalName),
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
  readonly context: ManifestRunContext
  readonly diagnostics: ManifestDiagnostic[]
  readonly entries: Map<string, ManifestEntryV1>
  readonly index: number
  readonly journalPath: string
  readonly lastNonEmptyIndex: number
  readonly line: string
  readonly tools: Partial<ManifestToolVersions>
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

const sanitizeJournalToken = (value: string): string => {
  const sanitized = value.replace(/[^a-z0-9_-]+/giu, '_')
  return sanitized || 'worker'
}
