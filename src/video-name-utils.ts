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
  parent?: string
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
  if (
    options.fileNameStyle === 'session' ||
    options.fileNameStyle === 'sessionFull'
  ) {
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
  fileNameStyle: WdioPuppeteerVideoServiceFileNameStyle = 'test',
): SlugMetadata => {
  const testRecord = test as unknown as TestLikeRecord
  const contextRecords = collectContextRecords(context)

  const fileToken = extractFileToken(
    buildFileCandidates(testRecord, contextRecords),
  )
  const testNameToken = pickBestNameToken(
    buildNameCandidates(testRecord, contextRecords, fileNameStyle),
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
  fileNameStyle: WdioPuppeteerVideoServiceFileNameStyle,
): Array<string | undefined> => {
  const preferFullTestName = fileNameStyle === 'testFull'

  return [
    ...buildRecordNameCandidates(testRecord, preferFullTestName),
    ...buildRecordNameCandidates(
      contextRecords.contextTestRecord,
      preferFullTestName,
    ),
    toNonEmptyString(contextRecords.contextPickleRecord?.name),
    toNonEmptyString(contextRecords.contextScenarioRecord?.name),
  ]
}

const buildRecordNameCandidates = (
  record: TestLikeRecord | undefined,
  preferFullTestName: boolean,
): Array<string | undefined> => {
  if (!record) {
    return []
  }

  const explicitFullNameCandidates = buildExplicitFullNameCandidates(record)

  if (preferFullTestName) {
    return [
      ...buildPreferredFullNameCandidates(record),
      record.title,
      record.description,
      record.name,
      record.pickle?.name,
      record.scenario?.name,
    ]
  }

  return [
    record.title,
    record.description,
    ...explicitFullNameCandidates,
    record.name,
    record.pickle?.name,
    record.scenario?.name,
  ]
}

const buildPreferredFullNameCandidates = (record: TestLikeRecord): string[] => {
  return uniqueDefinedValues([
    ...buildExplicitFullNameCandidates(record),
    buildParentQualifiedName(record),
  ])
}

const buildExplicitFullNameCandidates = (record: TestLikeRecord): string[] => {
  return uniqueDefinedValues([
    toDistinctFullNameCandidate(record.fullTitle, record.title),
    toDistinctFullNameCandidate(record.fullName, record.title),
  ])
}

const buildHashInputParts = (
  testRecord: TestLikeRecord,
  contextRecords: ContextRecords,
  retryCount: number,
): string[] => {
  return [
    ...buildRecordHashInputParts(testRecord),
    ...buildRecordHashInputParts(contextRecords.contextTestRecord),
    toNonEmptyString(contextRecords.contextPickleRecord?.name),
    toNonEmptyString(contextRecords.contextScenarioRecord?.name),
    toNonEmptyString(contextRecords.contextFeatureRecord?.name),
    String(retryCount),
  ].filter((value): value is string => typeof value === 'string')
}

const buildRecordHashInputParts = (
  record: TestLikeRecord | undefined,
): Array<string | undefined> => {
  if (!record) {
    return []
  }

  return [
    record.file,
    record.uri,
    record.parent,
    buildParentQualifiedName(record),
    record.title,
    record.description,
    record.fullTitle,
    record.fullName,
    record.name,
    record.pickle?.name,
    record.scenario?.name,
  ]
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

const buildParentQualifiedName = (
  record: TestLikeRecord | undefined,
): string | undefined => {
  if (!record) {
    return undefined
  }

  const parent = toNonEmptyString(record.parent)
  const child =
    toNonEmptyString(record.title) ??
    toNonEmptyString(record.description) ??
    toNonEmptyString(record.name) ??
    toNonEmptyString(record.pickle?.name) ??
    toNonEmptyString(record.scenario?.name)

  if (!parent || !child) {
    return undefined
  }

  if (child === parent || child.startsWith(`${parent} `)) {
    return child
  }

  return `${parent} ${child}`
}

const toDistinctFullNameCandidate = (
  candidate: string | undefined,
  title: string | undefined,
): string | undefined => {
  const normalizedCandidate = toNonEmptyString(candidate)
  if (!normalizedCandidate) {
    return undefined
  }

  if (normalizedCandidate === toNonEmptyString(title)) {
    return undefined
  }

  return normalizedCandidate
}

const uniqueDefinedValues = (values: Array<string | undefined>): string[] => {
  const uniqueValues: string[] = []
  const seen = new Set<string>()

  for (const value of values) {
    if (!value || seen.has(value)) {
      continue
    }

    uniqueValues.push(value)
    seen.add(value)
  }

  return uniqueValues
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
