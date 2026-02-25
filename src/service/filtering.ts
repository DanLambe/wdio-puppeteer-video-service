import type { Frameworks } from '@wdio/types'
import type { WdioPuppeteerVideoServiceOptions } from '../types.js'
import { normalizeCandidateValue, toNonEmptyString } from './normalization.js'

/**
 * Pure helpers for deciding whether a test/scenario should be recorded
 * based on normalized spec and tag pattern filters.
 */

interface TestSpecLike {
  file?: string
  uri?: string
  scenario?: {
    uri?: string
  }
}

interface TestTagLike {
  tags?: unknown
  pickle?: {
    tags?: unknown
  }
  scenario?: {
    tags?: unknown
  }
}

export const shouldRecordForFilters = (
  options: Pick<
    WdioPuppeteerVideoServiceOptions,
    | 'includeSpecPatterns'
    | 'excludeSpecPatterns'
    | 'includeTagPatterns'
    | 'excludeTagPatterns'
  >,
  test: Frameworks.Test,
  context: unknown,
  wildcardPatternRegexCache: Map<string, RegExp>,
): boolean => {
  const includeSpecPatterns = options.includeSpecPatterns ?? []
  const excludeSpecPatterns = options.excludeSpecPatterns ?? []
  const includeTagPatterns = options.includeTagPatterns ?? []
  const excludeTagPatterns = options.excludeTagPatterns ?? []

  if (
    includeSpecPatterns.length === 0 &&
    excludeSpecPatterns.length === 0 &&
    includeTagPatterns.length === 0 &&
    excludeTagPatterns.length === 0
  ) {
    return true
  }

  const specPath = resolveEntitySpecPath(test, context)
  if (
    includeSpecPatterns.length > 0 &&
    !matchesAnyPattern(specPath, includeSpecPatterns, wildcardPatternRegexCache)
  ) {
    return false
  }

  if (
    excludeSpecPatterns.length > 0 &&
    matchesAnyPattern(specPath, excludeSpecPatterns, wildcardPatternRegexCache)
  ) {
    return false
  }

  const entityTags = extractEntityTagTokens(test, context)
  if (includeTagPatterns.length > 0) {
    const includesAnyTag = entityTags.some((tagToken) =>
      matchesAnyPattern(
        tagToken,
        includeTagPatterns,
        wildcardPatternRegexCache,
      ),
    )
    if (!includesAnyTag) {
      return false
    }
  }

  if (excludeTagPatterns.length > 0) {
    const hasExcludedTag = entityTags.some((tagToken) =>
      matchesAnyPattern(
        tagToken,
        excludeTagPatterns,
        wildcardPatternRegexCache,
      ),
    )
    if (hasExcludedTag) {
      return false
    }
  }

  return true
}

/**
 * Resolves the best available spec path from WDIO/Jasmine/Cucumber metadata.
 */
export const resolveEntitySpecPath = (
  test: Frameworks.Test,
  context: unknown,
): string => {
  const testRecord = test as Frameworks.Test & TestSpecLike
  const contextRecord =
    context && typeof context === 'object'
      ? (context as Record<string, unknown>)
      : undefined
  const contextCurrentTest =
    contextRecord &&
    typeof contextRecord.currentTest === 'object' &&
    contextRecord.currentTest
      ? (contextRecord.currentTest as Record<string, unknown>)
      : undefined
  const contextFeature =
    contextRecord &&
    typeof contextRecord.feature === 'object' &&
    contextRecord.feature
      ? (contextRecord.feature as Record<string, unknown>)
      : undefined
  const contextScenario =
    contextRecord &&
    typeof contextRecord.scenario === 'object' &&
    contextRecord.scenario
      ? (contextRecord.scenario as Record<string, unknown>)
      : undefined

  const candidates = [
    testRecord.file,
    testRecord.uri,
    testRecord.scenario?.uri,
    toNonEmptyString(contextCurrentTest?.file),
    toNonEmptyString(contextCurrentTest?.uri),
    toNonEmptyString(contextRecord?.uri),
    toNonEmptyString(contextFeature?.uri),
    toNonEmptyString(contextScenario?.uri),
  ]

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeCandidateValue(candidate)
    if (normalizedCandidate) {
      return normalizedCandidate
    }
  }

  return ''
}

/**
 * Extracts normalized, deduplicated tag tokens from test/context metadata.
 */
export const extractEntityTagTokens = (
  test: Frameworks.Test,
  context: unknown,
): string[] => {
  const testRecord = test as Frameworks.Test & TestTagLike
  const contextRecord =
    context && typeof context === 'object'
      ? (context as Record<string, unknown>)
      : undefined
  const contextCurrentTest =
    contextRecord &&
    typeof contextRecord.currentTest === 'object' &&
    contextRecord.currentTest
      ? (contextRecord.currentTest as Record<string, unknown>)
      : undefined
  const contextPickle =
    contextRecord &&
    typeof contextRecord.pickle === 'object' &&
    contextRecord.pickle
      ? (contextRecord.pickle as Record<string, unknown>)
      : undefined
  const contextScenario =
    contextRecord &&
    typeof contextRecord.scenario === 'object' &&
    contextRecord.scenario
      ? (contextRecord.scenario as Record<string, unknown>)
      : undefined

  const rawTagSources: unknown[] = [
    testRecord.tags,
    testRecord.pickle?.tags,
    testRecord.scenario?.tags,
    contextCurrentTest?.tags,
    contextPickle?.tags,
    contextScenario?.tags,
    contextRecord?.tags,
  ]

  const normalizedTagTokens: string[] = []
  const seen = new Set<string>()
  for (const source of rawTagSources) {
    const extracted = collectTagStrings(source)
    for (const tagValue of extracted) {
      const normalizedTag = normalizeCandidateValue(tagValue)
      if (!normalizedTag || seen.has(normalizedTag)) {
        continue
      }
      seen.add(normalizedTag)
      normalizedTagTokens.push(normalizedTag)
    }
  }

  return normalizedTagTokens
}

export const collectTagStrings = (source: unknown): string[] => {
  if (!source) {
    return []
  }

  if (typeof source === 'string') {
    return [source]
  }

  if (Array.isArray(source)) {
    return source.flatMap((entry) => collectTagStrings(entry))
  }

  if (typeof source === 'object') {
    const sourceRecord = source as Record<string, unknown>
    const namedTag = toNonEmptyString(sourceRecord.name)
    if (namedTag) {
      return [namedTag]
    }

    return []
  }

  return []
}

export const matchesAnyPattern = (
  value: string,
  patterns: string[] | undefined,
  wildcardPatternRegexCache: Map<string, RegExp>,
): boolean => {
  if (!value || !patterns || patterns.length === 0) {
    return false
  }

  const normalizedValue = value.toLowerCase()
  for (const pattern of patterns) {
    if (matchesPattern(normalizedValue, pattern, wildcardPatternRegexCache)) {
      return true
    }
  }

  return false
}

export const matchesPattern = (
  value: string,
  pattern: string,
  wildcardPatternRegexCache: Map<string, RegExp>,
): boolean => {
  if (!pattern) {
    return false
  }

  if (!pattern.includes('*')) {
    return value.includes(pattern)
  }

  let cachedRegex = wildcardPatternRegexCache.get(pattern)
  if (!cachedRegex) {
    const escapedPattern = pattern.replaceAll(
      /[.+?^${}()|[\]\\]/g,
      String.raw`\$&`,
    )
    const regexSource = `^${escapedPattern.replaceAll('*', '.*')}$`
    cachedRegex = new RegExp(regexSource)
    wildcardPatternRegexCache.set(pattern, cachedRegex)
  }

  return cachedRegex.test(value)
}
