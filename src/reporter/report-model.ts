import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  ManifestEntryV1,
  ManifestMediaArtifact,
  ManifestRunV1,
} from '../manifest.js'
import type {
  ReporterDiagnostic,
  ReporterErrorDetails,
  ReporterFragmentV1,
  ReporterTestOutcome,
  ReporterTestStatus,
} from './types.js'

export interface ReportMedia {
  readonly path: string
  readonly href: string
  readonly mimeType: string
  readonly size: number
  readonly width?: number
  readonly height?: number
  available: boolean
}

export interface ReportItem {
  readonly id: string
  readonly status: ReporterTestStatus
  readonly spec: string
  readonly browser: string
  readonly testName: string
  readonly fullName?: string
  readonly containerName?: string
  readonly attempt: number
  readonly retried: boolean
  readonly durationMs: number
  readonly captureDecision?: string
  readonly captureReason?: string
  readonly processingOutcome?: string
  readonly pendingReason?: string
  readonly errors?: ReporterErrorDetails[]
  readonly media: ReportMedia[]
}

export interface ReportModel {
  readonly runId: string
  readonly generatedAt: string
  readonly items: ReportItem[]
  readonly diagnostics: ReporterDiagnostic[]
}

export const createReportModel = async (options: {
  readonly outputDir: string
  readonly runId: string
  readonly fragments: ReporterFragmentV1[]
  readonly run: ManifestRunV1 | undefined
  readonly initialDiagnostics: ReporterDiagnostic[]
}): Promise<ReportModel> => {
  const diagnostics = [...options.initialDiagnostics]
  diagnostics.push(
    ...(options.run?.diagnostics ?? []).map<ReporterDiagnostic>(
      (diagnostic) => ({
        code: 'manifest-diagnostic',
        message: `${diagnostic.code} in ${diagnostic.journal} at line ${diagnostic.line.toString()}`,
      }),
    ),
  )
  const matchedEntries = new Set<string>()
  const scenarioAssignments = new Map<string, string>()
  const entries = options.run?.entries ?? []
  const outcomes = options.fragments.flatMap((fragment) => fragment.outcomes)
  const items = outcomes.map((outcome) =>
    createOutcomeReportItem({
      diagnostics,
      entries,
      hasManifest: options.run !== undefined,
      matchedEntries,
      outcome,
      scenarioAssignments,
    }),
  )
  const unmatchedEntries = entries.filter(
    (entry) => !matchedEntries.has(entry.id),
  )
  diagnostics.push(...unmatchedEntries.map(createUnmatchedEntryDiagnostic))
  items.push(...unmatchedEntries.map(createManifestOnlyReportItem))
  await checkMediaAvailability(options.outputDir, items, diagnostics)
  items.sort(compareReportItems)
  diagnostics.sort(compareDiagnostics)
  return {
    runId: options.runId,
    generatedAt: resolveGeneratedAt(options.run, options.fragments),
    items,
    diagnostics,
  }
}

const createOutcomeReportItem = (options: {
  readonly diagnostics: ReporterDiagnostic[]
  readonly entries: ManifestEntryV1[]
  readonly hasManifest: boolean
  readonly matchedEntries: Set<string>
  readonly outcome: ReporterTestOutcome
  readonly scenarioAssignments: Map<string, string>
}): ReportItem => {
  const entry = findManifestEntry(
    options.entries,
    options.outcome,
    options.matchedEntries,
    options.scenarioAssignments,
  )
  if (entry) {
    options.matchedEntries.add(entry.id)
  } else if (options.hasManifest) {
    options.diagnostics.push({
      code: 'unmatched-test-outcome',
      message: `No manifest capture matched ${options.outcome.cid} / ${options.outcome.test.fullName ?? options.outcome.test.name} / attempt ${options.outcome.attempt.toString()}`,
    })
  }
  return createReportItem(options.outcome, entry)
}

const createUnmatchedEntryDiagnostic = (
  entry: ManifestEntryV1,
): ReporterDiagnostic => ({
  code: 'unmatched-manifest-entry',
  message: `Manifest capture ${entry.id} has no reporter outcome`,
})

const findManifestEntry = (
  entries: ManifestEntryV1[],
  outcome: ReporterTestOutcome,
  matchedEntries: ReadonlySet<string>,
  scenarioAssignments: Map<string, string>,
): ManifestEntryV1 | undefined => {
  const candidates = entries.filter((entry) => {
    return (
      entry.runId === outcome.runId &&
      entry.cid === outcome.cid &&
      normalizePathForComparison(entry.spec) ===
        normalizePathForComparison(outcome.spec) &&
      entry.attempt === outcome.attempt
    )
  })
  const exact = candidates.find((entry) => {
    return (
      entry.scope === 'test' &&
      !matchedEntries.has(entry.id) &&
      testIdentityMatches(entry, outcome)
    )
  })
  const containerName = outcome.test.containerName
  const scenario = containerName
    ? resolveScenarioEntry({
        candidates,
        containerName,
        matchedEntries,
        outcome,
        scenarioAssignments,
      })
    : undefined
  return scenario ?? exact ?? candidates.find((entry) => entry.scope === 'spec')
}

/**
 * Cucumber emits one outcome per step, so every step of a scenario must resolve
 * to the same manifest entry while distinct scenarios that share a title claim
 * different entries. The first step of a scenario claims the next unmatched
 * same-titled entry and later steps reuse that assignment; excluding matched
 * entries alone would push a scenario's later steps onto the next entry.
 */
const resolveScenarioEntry = (input: {
  readonly candidates: ManifestEntryV1[]
  readonly containerName: string
  readonly matchedEntries: ReadonlySet<string>
  readonly outcome: ReporterTestOutcome
  readonly scenarioAssignments: Map<string, string>
}): ManifestEntryV1 | undefined => {
  const assignmentKey = buildScenarioAssignmentKey(
    input.outcome,
    input.containerName,
  )
  const assignedEntryId = input.scenarioAssignments.get(assignmentKey)
  if (assignedEntryId !== undefined) {
    const assigned = input.candidates.find(
      (entry) => entry.id === assignedEntryId,
    )
    if (assigned) {
      return assigned
    }
  }

  const claimed = input.candidates.find((entry) => {
    return (
      entry.scope === 'test' &&
      !input.matchedEntries.has(entry.id) &&
      containerIdentityMatches(entry, input.containerName)
    )
  })
  if (claimed) {
    input.scenarioAssignments.set(assignmentKey, claimed.id)
  }
  return claimed
}

/**
 * Cucumber's step payload carries the scenario's id as `test.parent`, which
 * stays stable across a scenario's steps and differs between scenarios,
 * including expanded Scenario Outline rows.
 */
const buildScenarioAssignmentKey = (
  outcome: ReporterTestOutcome,
  containerName: string,
): string => {
  return [
    outcome.runId,
    outcome.cid,
    normalizePathForComparison(outcome.spec),
    outcome.attempt.toString(),
    outcome.test.parent ?? '',
    normalizeIdentity(containerName),
  ].join('\0')
}

const testIdentityMatches = (
  entry: ManifestEntryV1,
  outcome: ReporterTestOutcome,
): boolean => {
  if (!entry.test) {
    return false
  }
  const entryFullName = normalizeIdentity(
    entry.test.fullName ?? entry.test.name,
  )
  const outcomeFullName = normalizeIdentity(
    outcome.test.fullName ?? outcome.test.name,
  )
  const entryNames = [entryFullName, normalizeIdentity(entry.test.name)]
  const outcomeNames = new Set([
    outcomeFullName,
    normalizeIdentity(outcome.test.name),
  ])
  return entryNames.some((entryName) => outcomeNames.has(entryName))
}

const containerIdentityMatches = (
  entry: ManifestEntryV1,
  containerName: string,
): boolean => {
  if (!entry.test) {
    return false
  }
  const normalizedContainer = normalizeIdentity(containerName)
  return [entry.test.fullName, entry.test.name]
    .filter((name): name is string => !!name)
    .map(normalizeIdentity)
    .includes(normalizedContainer)
}

const createReportItem = (
  outcome: ReporterTestOutcome,
  entry: ManifestEntryV1 | undefined,
): ReportItem => ({
  id: `${outcome.cid}-${outcome.uid}-${outcome.attempt.toString()}`,
  status: outcome.status,
  spec: outcome.spec,
  browser: formatBrowser(entry, outcome),
  testName: outcome.test.name,
  ...(outcome.test.fullName ? { fullName: outcome.test.fullName } : {}),
  ...(outcome.test.containerName
    ? { containerName: outcome.test.containerName }
    : {}),
  attempt: outcome.attempt,
  retried: outcome.retried,
  durationMs: outcome.durationMs,
  ...(entry ? { captureDecision: entry.capture.decision } : {}),
  ...(entry?.capture.reason ? { captureReason: entry.capture.reason } : {}),
  ...(entry ? { processingOutcome: entry.processing.outcome } : {}),
  ...(outcome.pendingReason ? { pendingReason: outcome.pendingReason } : {}),
  ...(outcome.errors ? { errors: outcome.errors } : {}),
  media: entry ? createReportMedia(entry) : [],
})

const createManifestOnlyReportItem = (entry: ManifestEntryV1): ReportItem => ({
  id: `manifest-${entry.id}`,
  status: entry.result,
  spec: entry.spec,
  browser: formatManifestBrowser(entry),
  testName: entry.test?.name ?? 'Unassociated capture',
  ...(entry.test?.fullName ? { fullName: entry.test.fullName } : {}),
  attempt: entry.attempt,
  retried: entry.attempt > 1,
  durationMs: entry.timings.durationMs,
  captureDecision: entry.capture.decision,
  ...(entry.capture.reason ? { captureReason: entry.capture.reason } : {}),
  processingOutcome: entry.processing.outcome,
  media: createReportMedia(entry),
})

const createReportMedia = (entry: ManifestEntryV1): ReportMedia[] => {
  const artifacts = entry.capture.final
    ? [entry.capture.final]
    : entry.capture.segments
  return artifacts.map(createMedia)
}

const createMedia = (artifact: ManifestMediaArtifact): ReportMedia => ({
  path: artifact.path,
  href: createRelativeMediaHref(artifact.path),
  mimeType: artifact.mimeType,
  size: artifact.size,
  ...(artifact.width ? { width: artifact.width } : {}),
  ...(artifact.height ? { height: artifact.height } : {}),
  available: true,
})

const checkMediaAvailability = async (
  outputDir: string,
  items: ReportItem[],
  diagnostics: ReporterDiagnostic[],
): Promise<void> => {
  const media = items.flatMap((item) => item.media)
  const missingPaths = await Promise.all(
    media.map((item) => resolveMediaAvailability(outputDir, item)),
  )
  diagnostics.push(
    ...missingPaths
      .filter((missingPath): missingPath is string => !!missingPath)
      .map(createMissingMediaDiagnostic),
  )
}

const resolveMediaAvailability = async (
  outputDir: string,
  media: ReportMedia,
): Promise<string | undefined> => {
  media.available = await fs
    .stat(path.resolve(outputDir, media.path))
    .then((stats) => stats.isFile())
    .catch(() => false)
  return media.available ? undefined : media.path
}

const createMissingMediaDiagnostic = (path: string): ReporterDiagnostic => ({
  code: 'missing-media-artifact',
  message: `Media artifact is missing: ${path}`,
})

const compareReportItems = (left: ReportItem, right: ReportItem): number => {
  return (
    left.spec.localeCompare(right.spec) ||
    left.testName.localeCompare(right.testName) ||
    left.attempt - right.attempt
  )
}

const compareDiagnostics = (
  left: ReporterDiagnostic,
  right: ReporterDiagnostic,
): number => {
  return (
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  )
}

const formatBrowser = (
  entry: ManifestEntryV1 | undefined,
  outcome: ReporterTestOutcome,
): string => {
  return entry ? formatManifestBrowser(entry) : outcomeBrowserFallback(outcome)
}

const formatManifestBrowser = (entry: ManifestEntryV1): string => {
  return entry.browser.version
    ? `${entry.browser.name} ${entry.browser.version}`
    : entry.browser.name
}

const outcomeBrowserFallback = (outcome: ReporterTestOutcome): string => {
  return outcome.browser.version
    ? `${outcome.browser.name} ${outcome.browser.version}`
    : outcome.browser.name
}

const normalizeIdentity = (value: string): string => {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
}

const normalizePathForComparison = (value: string): string => {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase()
}

const createRelativeMediaHref = (relativePath: string): string => {
  return `./${relativePath.split('/').map(encodeURIComponent).join('/')}`
}

const resolveGeneratedAt = (
  run: ManifestRunV1 | undefined,
  fragments: ReporterFragmentV1[],
): string => {
  if (run) {
    return run.completedAt
  }
  return (
    fragments
      .map((fragment) => fragment.completedAt)
      .toSorted((left, right) => left.localeCompare(right))
      .at(-1) ?? new Date(0).toISOString()
  )
}
