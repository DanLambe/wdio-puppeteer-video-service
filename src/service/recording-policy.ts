import path from 'node:path'
import type {
  ResolvedProcessingOptions,
  ResolvedRecordingOptions,
} from '../types.js'
import { type SlugMetadata, sanitizeFileToken } from '../video-name-utils.js'
import type { ResolvedRetryContext } from './constants.js'
import {
  type RecordingFilterConfiguration,
  shouldRecordNormalizedEntity,
} from './filtering.js'
import type { CompleteManifestEntryOptions } from './manifest-runtime.js'
import type { RecordingEntity } from './recording-entity.js'

export interface RecordingAvailability {
  readonly available: boolean
  readonly reason?: string
}

export type RecordingEligibility =
  | { readonly eligible: true }
  | {
      readonly eligible: false
      readonly reason: string
    }

export type RecordingStartDecision =
  | {
      readonly action: 'continue-spec'
      readonly retryContext: ResolvedRetryContext
    }
  | {
      readonly action: 'skip'
      readonly reason: 'not-a-retry-attempt'
      readonly retryContext: ResolvedRetryContext
    }
  | {
      readonly action: 'start'
      readonly metadata: Readonly<SlugMetadata>
      readonly retryContext: ResolvedRetryContext
    }

export const evaluateRecordingEligibility = (
  entity: RecordingEntity,
  availability: RecordingAvailability,
  filters: RecordingFilterConfiguration,
  wildcardPatternRegexCache: Map<string, RegExp>,
): RecordingEligibility => {
  if (!availability.available) {
    return Object.freeze({
      eligible: false,
      reason: availability.reason ?? 'recording-hooks-unavailable',
    })
  }

  if (
    !shouldRecordNormalizedEntity(filters, entity, wildcardPatternRegexCache)
  ) {
    return Object.freeze({ eligible: false, reason: 'filtered' })
  }

  return Object.freeze({ eligible: true })
}

export const resolveRecordingAttempt = (input: {
  readonly entity: RecordingEntity
  readonly inferredEntityRetry: number | undefined
  readonly specFileRetryAttempt: number
}): ResolvedRetryContext => {
  const effectiveRetryCount = Math.max(
    input.entity.explicitFrameworkRetry ?? 0,
    input.specFileRetryAttempt,
    input.inferredEntityRetry ?? 0,
  )

  return Object.freeze({
    explicitFrameworkRetry: input.entity.explicitFrameworkRetry,
    specFileRetryAttempt: input.specFileRetryAttempt,
    inferredEntityRetry: input.inferredEntityRetry,
    effectiveRetryCount,
  })
}

export const decideRecordingStart = (input: {
  readonly attempts: ResolvedRecordingOptions['attempts']
  readonly entity: RecordingEntity
  readonly retryContext: ResolvedRetryContext
  readonly scope: ResolvedRecordingOptions['scope']
  readonly specPaths: readonly string[]
  readonly specRecordingActive: boolean
}): RecordingStartDecision => {
  if (
    input.attempts === 'retries' &&
    input.retryContext.effectiveRetryCount === 0
  ) {
    return Object.freeze({
      action: 'skip',
      reason: 'not-a-retry-attempt',
      retryContext: input.retryContext,
    })
  }

  if (input.scope === 'spec' && input.specRecordingActive) {
    return Object.freeze({
      action: 'continue-spec',
      retryContext: input.retryContext,
    })
  }

  const metadata =
    input.scope === 'spec'
      ? buildSpecLevelSlugMetadata(
          input.specPaths,
          input.retryContext.effectiveRetryCount,
        )
      : applyRetryCountToMetadata(
          input.entity.slugMetadata,
          input.retryContext.effectiveRetryCount,
        )

  return Object.freeze({
    action: 'start',
    metadata,
    retryContext: input.retryContext,
  })
}

export const createRetryTrackingKey = (entity: RecordingEntity): string => {
  if (entity.frameworkEntityId) {
    // A framework-assigned id is stable across retry attempts and distinct
    // between same-named entities, so it identifies the entity exactly.
    return `framework-id|${entity.specPath}|${entity.frameworkEntityId}`
  }

  const metadata = entity.slugMetadata
  return `${metadata.fileToken}|${metadata.testNameToken}|${metadata.hashInput}`
}

export const applyRetryCountToMetadata = (
  metadata: Readonly<SlugMetadata>,
  retryCount: number,
): Readonly<SlugMetadata> => {
  if (retryCount <= 0) {
    return Object.freeze({
      ...metadata,
      retryToken: '',
    })
  }

  return Object.freeze({
    ...metadata,
    retryToken: `_retry${retryCount}`,
    hashInput: `${metadata.hashInput}|retry=${retryCount}`,
  })
}

export const buildSpecLevelSlugMetadata = (
  specPaths: readonly string[],
  retryCount: number,
): Readonly<SlugMetadata> => {
  const firstSpecPath = specPaths[0] || 'spec'
  const parsedSpecName = path.parse(firstSpecPath).name
  const specToken = sanitizeFileToken(parsedSpecName, 120) || 'spec'
  const specNameToken = specToken.endsWith('_spec')
    ? specToken
    : `${specToken}_spec`
  const allSpecsToken =
    specPaths.length > 0 ? specPaths.join('|') : firstSpecPath

  return Object.freeze({
    fileToken: specToken,
    testNameToken: specNameToken,
    retryToken: retryCount > 0 ? `_retry${retryCount}` : '',
    hashInput: `spec|${allSpecsToken}|${retryCount}`,
  })
}

export const shouldRetainRecording = (input: {
  readonly passed: boolean
  readonly retain: ResolvedRecordingOptions['retain']
  readonly retryCount: number
}): boolean => {
  switch (input.retain) {
    case 'all':
      return true
    case 'retries':
      return input.retryCount > 0
    default:
      return !input.passed
  }
}

export const createCompletedManifestOptions = (input: {
  readonly deferred: boolean
  readonly keepArtifacts: boolean
  readonly passed: boolean
  readonly paths: readonly string[]
  readonly processing: ResolvedProcessingOptions
}): CompleteManifestEntryOptions => {
  let decision: CompleteManifestEntryOptions['decision'] = 'discarded'
  if (input.keepArtifacts) {
    decision = input.paths.length > 0 ? 'recorded' : 'failed'
  }

  let processingOutcome: CompleteManifestEntryOptions['processingOutcome'] =
    'skipped'
  if (input.deferred) {
    processingOutcome = 'pending'
  } else if (input.keepArtifacts) {
    processingOutcome = isPostProcessingConfigured(input.processing)
      ? 'completed'
      : 'not-required'
  }

  const processingOperation = resolveProcessingOperation(input.processing)
  return {
    decision,
    result: input.passed ? 'passed' : 'failed',
    paths: [...input.paths],
    ...(!input.keepArtifacts ? { reason: 'retention-policy' } : {}),
    processingOutcome,
    ...(processingOperation ? { processingOperation } : {}),
  }
}

export const resolveProcessingOperation = (
  processing: ResolvedProcessingOptions,
): CompleteManifestEntryOptions['processingOperation'] | undefined => {
  if (processing.merge.enabled) {
    return 'merge'
  }
  if (processing.transcode.enabled) {
    return 'transcode'
  }
  return undefined
}

const isPostProcessingConfigured = (
  processing: ResolvedProcessingOptions,
): boolean => {
  return processing.merge.enabled || processing.transcode.enabled
}
