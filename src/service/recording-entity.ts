import type { Frameworks } from '@wdio/types'
import type { ManifestFramework, ManifestResult } from '../manifest.js'
import type { ArtifactNameStyle } from '../types.js'
import { collectSlugMetadata, type SlugMetadata } from '../video-name-utils.js'
import { extractEntityTagTokens, resolveEntitySpecPath } from './filtering.js'

export type RecordingEntityKind = 'scenario' | 'test'

export interface RecordingEntity {
  readonly context: unknown
  readonly explicitFrameworkRetry: number | undefined
  readonly framework: ManifestFramework
  readonly kind: RecordingEntityKind
  readonly label: string
  readonly manifestResultWhenSkipped: ManifestResult
  readonly manifestTest: Frameworks.Test
  readonly pending: boolean
  readonly slugMetadata: Readonly<SlugMetadata>
  readonly specPath: string
  readonly tags: readonly string[]
}

export interface RecordingEntityOutcome {
  readonly manifestResult: ManifestResult
  readonly passed: boolean
}

export const normalizeTestEntity = (
  test: Frameworks.Test,
  context: unknown,
  framework: ManifestFramework,
  fileNameStyle: ArtifactNameStyle,
): RecordingEntity => {
  const pending = !!test.pending
  return createRecordingEntity({
    context,
    explicitFrameworkRetry: extractExplicitRetryCount(test, context),
    framework,
    kind: 'test',
    label: test.title || test.fullTitle || 'test',
    manifestResultWhenSkipped: pending ? 'skipped' : 'unknown',
    manifestTest: test,
    pending,
    slugMetadata: collectSlugMetadata(test, context, fileNameStyle),
  })
}

export const normalizeScenarioEntity = (
  world: Frameworks.World,
  context: unknown,
  fileNameStyle: ArtifactNameStyle,
): RecordingEntity => {
  const entityContext = context ?? world
  const title = world?.pickle?.name || 'scenario'
  const manifestTest = {
    title,
    fullTitle: title,
  } as Frameworks.Test

  return createRecordingEntity({
    context: entityContext,
    explicitFrameworkRetry: extractExplicitRetryCount(
      manifestTest,
      entityContext,
    ),
    framework: 'cucumber',
    kind: 'scenario',
    label: title,
    manifestResultWhenSkipped: 'unknown',
    manifestTest,
    pending: false,
    slugMetadata: collectSlugMetadata(
      manifestTest,
      entityContext,
      fileNameStyle,
    ),
  })
}

export const normalizeTestOutcome = (
  test: Frameworks.Test,
  result: Frameworks.TestResult,
): RecordingEntityOutcome => {
  return Object.freeze({
    manifestResult: resolveTestManifestResult(!!test.pending, result.passed),
    passed: result.passed,
  })
}

const resolveTestManifestResult = (
  pending: boolean,
  passed: boolean,
): ManifestResult => {
  if (pending) {
    return 'skipped'
  }
  return passed ? 'passed' : 'failed'
}

export const normalizeScenarioOutcome = (
  result: Frameworks.PickleResult,
): RecordingEntityOutcome => {
  return Object.freeze({
    manifestResult: result.passed ? ('passed' as const) : ('failed' as const),
    passed: result.passed,
  })
}

export const extractExplicitRetryCount = (
  test: Frameworks.Test,
  context: unknown,
): number | undefined => {
  const testRetryCount = normalizeRetryValue(
    (test as Frameworks.Test & { _currentRetry?: unknown })._currentRetry,
  )
  if (testRetryCount !== undefined) {
    return testRetryCount
  }

  const contextRecord = asRecord(context)
  const contextRetryCount = normalizeRetryValue(contextRecord?._currentRetry)
  if (contextRetryCount !== undefined) {
    return contextRetryCount
  }

  return normalizeRetryValue(
    asRecord(contextRecord?.currentTest)?._currentRetry,
  )
}

const createRecordingEntity = (input: {
  context: unknown
  explicitFrameworkRetry: number | undefined
  framework: ManifestFramework
  kind: RecordingEntityKind
  label: string
  manifestResultWhenSkipped: ManifestResult
  manifestTest: Frameworks.Test
  pending: boolean
  slugMetadata: SlugMetadata
}): RecordingEntity => {
  return Object.freeze({
    ...input,
    slugMetadata: Object.freeze({ ...input.slugMetadata }),
    specPath: resolveEntitySpecPath(input.manifestTest, input.context),
    tags: Object.freeze(
      extractEntityTagTokens(input.manifestTest, input.context),
    ),
  })
}

const normalizeRetryValue = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined
  }
  return Math.floor(value)
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  return value as Record<string, unknown>
}
