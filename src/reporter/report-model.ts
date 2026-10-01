import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  ManifestEntryV1,
  ManifestMediaArtifact,
  ManifestRunV1,
} from '../manifest.js'
import { type ManifestMatch, ManifestMatcher } from './manifest-matcher.js'
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
  const entries = options.run?.entries ?? []
  const matcher = new ManifestMatcher(entries)
  const outcomes = options.fragments.flatMap((fragment) => fragment.outcomes)
  const items = matcher.matchAll(outcomes).map(({ outcome, match }) =>
    createOutcomeReportItem({
      diagnostics,
      hasManifest: options.run !== undefined,
      match,
      outcome,
    }),
  )
  const unmatchedEntries = entries.filter(
    (entry) => !matcher.matchedEntries.has(entry.id),
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
  readonly hasManifest: boolean
  readonly match: ManifestMatch
  readonly outcome: ReporterTestOutcome
}): ReportItem => {
  const entry =
    options.match.kind === 'matched' ? options.match.entry : undefined
  if (!entry && options.hasManifest) {
    const ambiguous = options.match.kind === 'ambiguous'
    options.diagnostics.push({
      code: ambiguous ? 'ambiguous-test-outcome' : 'unmatched-test-outcome',
      message: `${ambiguous ? 'Multiple manifest captures could match' : 'No manifest capture matched'} ${options.outcome.cid} / ${options.outcome.test.fullName ?? options.outcome.test.name} / attempt ${options.outcome.attempt.toString()}`,
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
  const byPath = new Map<string, ReportMedia[]>()
  for (const item of items) {
    for (const media of item.media) {
      const references = byPath.get(media.path)
      if (references) {
        references.push(media)
      } else {
        byPath.set(media.path, [media])
      }
    }
  }
  const pending = byPath.entries()
  await Promise.all(
    Array.from({ length: Math.min(8, byPath.size) }, async () => {
      for (const [relativePath, references] of pending) {
        const available = await fs
          .stat(path.resolve(outputDir, relativePath))
          .then((stats) => stats.isFile())
          .catch(() => false)
        for (const media of references) {
          media.available = available
        }
        if (!available) {
          diagnostics.push(createMissingMediaDiagnostic(relativePath))
        }
      }
    }),
  )
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
