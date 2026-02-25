import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Frameworks } from '@wdio/types'
import type {
  WdioPuppeteerVideoServiceFileNameOverflowStrategy,
  WdioPuppeteerVideoServiceFileNameStyle,
} from './types.js'

interface TestLikeRecord {
  title?: string
  description?: string
  fullTitle?: string
  fullName?: string
  name?: string
  file?: string
  uri?: string
  _currentRetry?: number
  pickle?: {
    name?: string
  }
  scenario?: {
    name?: string
    uri?: string
  }
}

interface ContextRecords {
  contextRecord: Record<string, unknown> | undefined
  contextTestRecord: TestLikeRecord | undefined
  contextPickleRecord: Record<string, unknown> | undefined
  contextScenarioRecord: Record<string, unknown> | undefined
  contextFeatureRecord: Record<string, unknown> | undefined
}

export interface SlugMetadata {
  retryToken: string
  fileToken: string
  testNameToken: string
  hashInput: string
}

interface BuildTestSlugOptions {
  maxSlugLength: number
  fileNameStyle: WdioPuppeteerVideoServiceFileNameStyle
  fileNameOverflowStrategy: WdioPuppeteerVideoServiceFileNameOverflowStrategy
  sessionIdToken: string
  sessionIdFullToken: string
}

const GENERIC_TEST_NAME_TOKENS = new Set([
  'index',
  'spec',
  'test',
  'tests',
  'suite',
  'scenario',
  'feature',
  'anonymous',
])

export const buildTestSlugFromMetadata = (
  metadata: SlugMetadata,
  options: BuildTestSlugOptions,
): string => {
  if (options.fileNameStyle !== 'test') {
    return buildSessionOnlySlug(
      options.fileNameStyle,
      metadata.retryToken,
      options,
    )
  }

  const shortHash = createHash('sha256')
    .update(metadata.hashInput)
    .digest('hex')
    .slice(0, 8)
  const sessionPrefix = options.sessionIdToken
    ? `${options.sessionIdToken}_`
    : ''
  const suffixToken = `${sessionPrefix}${shortHash}${metadata.retryToken}`

  if (suffixToken.length >= options.maxSlugLength) {
    return buildOverflowSlug(shortHash, metadata.retryToken, options)
  }

  const baseBudget = Math.max(1, options.maxSlugLength - suffixToken.length - 1)
  const baseCandidate = sanitizeFileToken(metadata.testNameToken, baseBudget)
  const fallbackCandidate =
    sanitizeFileToken(metadata.fileToken, Math.min(40, baseBudget)) || 'test'

  if (options.fileNameOverflowStrategy === 'session') {
    const preferredBase = baseCandidate || fallbackCandidate
    const preferred = `${preferredBase}_${suffixToken}`
    if (preferred.length <= options.maxSlugLength) {
      return preferred
    }
    return buildOverflowSlug(shortHash, metadata.retryToken, options)
  }

  const selectedBase = baseCandidate || fallbackCandidate
  const slug = `${selectedBase}_${suffixToken}`
  if (slug.length <= options.maxSlugLength) {
    return slug
  }

  const trimmedBase = sanitizeFileToken(selectedBase, baseBudget)
  const trimmedSlug = `${trimmedBase || fallbackCandidate}_${suffixToken}`
  if (trimmedSlug.length <= options.maxSlugLength) {
    return trimmedSlug
  }

  return buildOverflowSlug(shortHash, metadata.retryToken, options)
}

export const collectSlugMetadata = (
  test: Frameworks.Test,
  context: unknown,
): SlugMetadata => {
  const testRecord = test as unknown as TestLikeRecord
  const contextRecords = collectContextRecords(context)

  const fileToken = extractFileToken(
    buildFileCandidates(testRecord, contextRecords),
  )
  const testNameToken = pickBestNameToken(
    buildNameCandidates(testRecord, contextRecords),
    fileToken,
  )
  const retryCount = extractRetryCount(
    testRecord,
    contextRecords.contextTestRecord,
  )
  const retryToken = retryCount > 0 ? `_retry${retryCount}` : ''
  const hashInputParts = buildHashInputParts(
    testRecord,
    contextRecords,
    retryCount,
  )

  const hashInput =
    hashInputParts.join('|') || `${fileToken}|${testNameToken}|${retryCount}`

  return {
    retryToken,
    fileToken,
    testNameToken,
    hashInput,
  }
}

export const reserveUniqueSlug = (
  baseSlug: string,
  maxSlugLength: number,
  slugUsageCount: Map<string, number>,
): string => {
  const normalizedBase = sanitizeFileToken(baseSlug, maxSlugLength) || 'test'
  const currentCount = slugUsageCount.get(normalizedBase) ?? 0
  const nextCount = currentCount + 1
  slugUsageCount.set(normalizedBase, nextCount)

  if (nextCount === 1) {
    return normalizedBase
  }

  const suffix = `_run${nextCount}`
  if (normalizedBase.length + suffix.length <= maxSlugLength) {
    return `${normalizedBase}${suffix}`
  }

  const baseBudget = Math.max(8, maxSlugLength - suffix.length)
  const trimmedBase =
    sanitizeFileToken(normalizedBase, baseBudget) ||
    normalizedBase.slice(0, baseBudget)
  return `${trimmedBase}${suffix}`
}

export const sanitizeFileToken = (
  value: string | undefined,
  maxLength: number,
): string => {
  const input = (value ?? '').toLowerCase()
  if (!input) {
    return ''
  }

  let normalized = ''
  let pendingUnderscore = false

  for (const char of input) {
    if (isLowerAlphaNumericChar(char)) {
      if (pendingUnderscore && normalized.length > 0) {
        normalized += '_'
      }
      normalized += char
      pendingUnderscore = false
      continue
    }

    pendingUnderscore = true
  }

  if (normalized.length <= maxLength) {
    return normalized
  }

  normalized = normalized.slice(0, maxLength)
  while (normalized.endsWith('_')) {
    normalized = normalized.slice(0, -1)
  }

  return normalized
}

export const buildSessionIdToken = (sessionId: string | undefined): string => {
  const primaryChunk = sessionId?.split('-')[0]
  const sanitizedPrimary = sanitizeFileToken(primaryChunk, 12)
  if (sanitizedPrimary) {
    return sanitizedPrimary.slice(0, 12)
  }

  const sanitized = sanitizeFileToken(sessionId, 12)
  return sanitized.slice(0, 12)
}

export const buildFullSessionIdToken = (
  sessionId: string | undefined,
): string => {
  const sanitized = sanitizeFileToken(sessionId, 64)
  if (sanitized) {
    return sanitized
  }

  return buildSessionIdToken(sessionId)
}

const buildSessionOnlySlug = (
  fileNameStyle: WdioPuppeteerVideoServiceFileNameStyle,
  retryToken: string,
  options: BuildTestSlugOptions,
): string => {
  const preferredSessionToken =
    fileNameStyle === 'sessionFull'
      ? options.sessionIdFullToken || options.sessionIdToken || 'session'
      : options.sessionIdToken || options.sessionIdFullToken || 'session'
  const sessionToken =
    sanitizeFileToken(preferredSessionToken, options.maxSlugLength) || 'session'

  if (!retryToken) {
    return sessionToken
  }

  if (sessionToken.length + retryToken.length <= options.maxSlugLength) {
    return `${sessionToken}${retryToken}`
  }

  const sessionBudget = Math.max(6, options.maxSlugLength - retryToken.length)
  const trimmedSession =
    sanitizeFileToken(sessionToken, sessionBudget) ||
    sessionToken.slice(0, sessionBudget)
  return `${trimmedSession}${retryToken}`
}

const buildOverflowSlug = (
  shortHash: string,
  retryToken: string,
  options: BuildTestSlugOptions,
): string => {
  const sessionToken = options.sessionIdToken || 'session'
  const full = `${sessionToken}_${shortHash}${retryToken}`
  if (full.length <= options.maxSlugLength) {
    return full
  }

  const compact = `${sessionToken}_${shortHash}`
  if (compact.length <= options.maxSlugLength) {
    return compact
  }

  const sessionBudget = Math.max(
    4,
    options.maxSlugLength - shortHash.length - 1,
  )
  const compactSession = sanitizeFileToken(sessionToken, sessionBudget)
  const compactSlug = `${compactSession}_${shortHash}`
  if (compactSlug.length <= options.maxSlugLength) {
    return compactSlug
  }

  return shortHash.slice(0, Math.max(6, options.maxSlugLength))
}

const collectContextRecords = (context: unknown): ContextRecords => {
  const contextRecord = asRecord(context)
  const contextTestRecord = asRecord(contextRecord?.currentTest) as
    | TestLikeRecord
    | undefined
  const contextPickleRecord = asRecord(contextRecord?.pickle)
  const contextScenarioRecord = asRecord(contextRecord?.scenario)
  const contextFeatureRecord = asRecord(contextRecord?.feature)

  return {
    contextRecord,
    contextTestRecord,
    contextPickleRecord,
    contextScenarioRecord,
    contextFeatureRecord,
  }
}

const buildFileCandidates = (
  testRecord: TestLikeRecord,
  contextRecords: ContextRecords,
): Array<string | undefined> => {
  return [
    testRecord.file,
    testRecord.uri,
    testRecord.scenario?.uri,
    contextRecords.contextTestRecord?.file,
    contextRecords.contextTestRecord?.uri,
    contextRecords.contextTestRecord?.scenario?.uri,
    toNonEmptyString(contextRecords.contextRecord?.uri),
    toNonEmptyString(contextRecords.contextScenarioRecord?.uri),
    toNonEmptyString(contextRecords.contextFeatureRecord?.uri),
  ]
}

const buildNameCandidates = (
  testRecord: TestLikeRecord,
  contextRecords: ContextRecords,
): Array<string | undefined> => {
  return [
    testRecord.title,
    testRecord.description,
    testRecord.fullTitle,
    testRecord.fullName,
    testRecord.name,
    testRecord.pickle?.name,
    testRecord.scenario?.name,
    contextRecords.contextTestRecord?.title,
    contextRecords.contextTestRecord?.description,
    contextRecords.contextTestRecord?.fullTitle,
    contextRecords.contextTestRecord?.fullName,
    contextRecords.contextTestRecord?.name,
    contextRecords.contextTestRecord?.pickle?.name,
    contextRecords.contextTestRecord?.scenario?.name,
    toNonEmptyString(contextRecords.contextPickleRecord?.name),
    toNonEmptyString(contextRecords.contextScenarioRecord?.name),
  ]
}

const buildHashInputParts = (
  testRecord: TestLikeRecord,
  contextRecords: ContextRecords,
  retryCount: number,
): string[] => {
  return [
    testRecord.file,
    testRecord.uri,
    testRecord.title,
    testRecord.description,
    testRecord.fullTitle,
    testRecord.fullName,
    testRecord.name,
    testRecord.pickle?.name,
    testRecord.scenario?.name,
    contextRecords.contextTestRecord?.file,
    contextRecords.contextTestRecord?.uri,
    contextRecords.contextTestRecord?.title,
    contextRecords.contextTestRecord?.description,
    contextRecords.contextTestRecord?.fullTitle,
    contextRecords.contextTestRecord?.fullName,
    contextRecords.contextTestRecord?.name,
    contextRecords.contextTestRecord?.pickle?.name,
    contextRecords.contextTestRecord?.scenario?.name,
    toNonEmptyString(contextRecords.contextPickleRecord?.name),
    toNonEmptyString(contextRecords.contextScenarioRecord?.name),
    toNonEmptyString(contextRecords.contextFeatureRecord?.name),
    String(retryCount),
  ].filter((value): value is string => typeof value === 'string')
}

const pickBestNameToken = (
  candidateNames: Array<string | undefined>,
  fileToken: string,
): string => {
  let fallbackToken: string | undefined

  for (const candidateName of candidateNames) {
    if (!candidateName) {
      continue
    }

    const sanitizedCandidate = sanitizeFileToken(candidateName, 180)
    if (!sanitizedCandidate) {
      continue
    }

    if (!fallbackToken) {
      fallbackToken = sanitizedCandidate
    }

    if (isGenericNameToken(sanitizedCandidate, fileToken)) {
      continue
    }

    return sanitizedCandidate
  }

  return fallbackToken || fileToken || 'test'
}

const isGenericNameToken = (candidate: string, fileToken: string): boolean => {
  return (
    GENERIC_TEST_NAME_TOKENS.has(candidate) ||
    candidate === fileToken ||
    candidate === `${fileToken}_spec`
  )
}

const extractFileToken = (candidates: Array<string | undefined>): string => {
  for (const candidate of candidates) {
    if (!candidate) {
      continue
    }

    const normalizedCandidate = candidate.trim()
    if (!normalizedCandidate) {
      continue
    }

    const candidateWithoutQuery =
      normalizedCandidate.split('?')[0] ?? normalizedCandidate
    const candidatePath = candidateWithoutQuery.startsWith('file://')
      ? candidateWithoutQuery.slice('file://'.length)
      : candidateWithoutQuery
    const parsed = path.parse(candidatePath)
    const fileName = parsed.name || path.basename(candidatePath)
    const token = sanitizeFileToken(fileName, 80)
    if (token) {
      return token
    }
  }

  return 'spec'
}

const extractRetryCount = (
  testRecord: TestLikeRecord,
  contextTestRecord: TestLikeRecord | undefined,
): number => {
  if (
    typeof testRecord._currentRetry === 'number' &&
    testRecord._currentRetry > 0
  ) {
    return testRecord._currentRetry
  }

  if (
    typeof contextTestRecord?._currentRetry === 'number' &&
    contextTestRecord._currentRetry > 0
  ) {
    return contextTestRecord._currentRetry
  }

  return 0
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  return value as Record<string, unknown>
}

const toNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmedValue = value.trim()
  if (!trimmedValue) {
    return undefined
  }

  return trimmedValue
}

const isLowerAlphaNumericChar = (char: string): boolean => {
  const code = char.codePointAt(0)
  if (code === undefined) {
    return false
  }

  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57)
}
