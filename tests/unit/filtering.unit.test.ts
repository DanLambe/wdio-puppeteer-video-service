import type { Frameworks } from '@wdio/types'
import { describe, expect, it } from 'vitest'
import type { RecordingFilterConfiguration } from '../../src/service/filtering.js'
import {
  collectTagStrings,
  extractEntityTagTokens,
  matchesAnyPattern,
  matchesPattern,
  resolveEntitySpecPath,
  shouldRecordNormalizedEntity,
} from '../../src/service/filtering.js'

const createTest = (metadata: Record<string, unknown> = {}): Frameworks.Test =>
  ({
    file: '',
    fullName: 'suite test',
    fullTitle: 'suite test',
    parent: 'suite',
    pending: false,
    title: 'test',
    type: 'test',
    ...metadata,
  }) as Frameworks.Test

/** Mirrors `createRecordingEntity`, which is how production reaches filtering. */
const shouldRecord = (
  options: RecordingFilterConfiguration,
  test: Frameworks.Test,
  context: unknown,
  wildcardPatternRegexCache: Map<string, RegExp>,
): boolean =>
  shouldRecordNormalizedEntity(
    options,
    {
      specPath: resolveEntitySpecPath(test, context),
      tags: extractEntityTagTokens(test, context),
    },
    wildcardPatternRegexCache,
  )

describe('recording filters', () => {
  it('resolves spec paths through every supported metadata fallback', () => {
    expect(resolveEntitySpecPath(createTest({ file: 'test.ts' }), {})).toBe(
      'test.ts',
    )
    expect(resolveEntitySpecPath(createTest({ uri: 'URI.TS' }), {})).toBe(
      'uri.ts',
    )
    expect(
      resolveEntitySpecPath(
        createTest({ scenario: { uri: 'scenario.feature' } }),
        {},
      ),
    ).toBe('scenario.feature')
    expect(
      resolveEntitySpecPath(createTest(), {
        currentTest: { file: 'current.ts' },
      }),
    ).toBe('current.ts')
    expect(
      resolveEntitySpecPath(createTest(), {
        currentTest: { uri: 'current.feature' },
      }),
    ).toBe('current.feature')
    expect(resolveEntitySpecPath(createTest(), { uri: 'context.ts' })).toBe(
      'context.ts',
    )
    expect(
      resolveEntitySpecPath(createTest(), {
        feature: { uri: 'feature.feature' },
      }),
    ).toBe('feature.feature')
    expect(
      resolveEntitySpecPath(createTest(), {
        scenario: { uri: 'context-scenario.feature' },
      }),
    ).toBe('context-scenario.feature')
    expect(resolveEntitySpecPath(createTest(), null)).toBe('')
    expect(resolveEntitySpecPath(createTest(), { currentTest: null })).toBe('')
  })

  it('collects nested tag shapes and rejects unsupported values', () => {
    expect(collectTagStrings(undefined)).toEqual([])
    expect(collectTagStrings('@smoke')).toEqual(['@smoke'])
    expect(
      collectTagStrings([
        '@one',
        [{ name: '@two' }, { name: '  ' }],
        { unsupported: true },
        42,
      ]),
    ).toEqual(['@one', '@two'])
    expect(collectTagStrings({ name: '@object' })).toEqual(['@object'])
    expect(collectTagStrings(false)).toEqual([])
  })

  it('normalizes and deduplicates tags from tests and Cucumber context', () => {
    const tags = extractEntityTagTokens(
      createTest({
        tags: ['@TEST', '@duplicate'],
        pickle: { tags: [{ name: '@pickle' }] },
        scenario: { tags: ['@scenario'] },
      }),
      {
        currentTest: { tags: ['@current'] },
        pickle: { tags: [{ name: '@context-pickle' }] },
        scenario: { tags: ['@context-scenario'] },
        tags: ['@duplicate', '', null],
      },
    )

    expect(tags).toEqual([
      '@test',
      '@duplicate',
      '@pickle',
      '@scenario',
      '@current',
      '@context-pickle',
      '@context-scenario',
    ])
    expect(extractEntityTagTokens(createTest(), 'invalid context')).toEqual([])
  })

  it('matches literal and cached wildcard patterns', () => {
    const cache = new Map<string, RegExp>()

    expect(matchesAnyPattern('', ['*'], cache)).toBe(false)
    expect(matchesAnyPattern('value', undefined, cache)).toBe(false)
    expect(matchesAnyPattern('value', [], cache)).toBe(false)
    expect(matchesPattern('value', '', cache)).toBe(false)
    expect(matchesPattern('checkout smoke', 'smoke', cache)).toBe(true)
    expect(matchesPattern('checkout smoke', 'regression', cache)).toBe(false)
    expect(matchesPattern('test[1].ts', 'test[1].*', cache)).toBe(true)
    expect(matchesPattern('test[2].ts', 'test[1].*', cache)).toBe(false)
    expect(cache.size).toBe(1)
    expect(
      matchesAnyPattern('test[1].ts', ['missing', 'test[1].*'], cache),
    ).toBe(true)
    expect(cache.size).toBe(1)
  })

  it('combines include and exclude filters without changing default behavior', () => {
    const cache = new Map<string, RegExp>()
    const test = createTest({ file: 'specs/checkout.spec.ts' })

    expect(shouldRecord({}, test, {}, cache)).toBe(true)
    expect(shouldRecord({ includeSpecs: ['*account*'] }, test, {}, cache)).toBe(
      false,
    )
    expect(
      shouldRecord({ includeSpecs: ['*checkout*'] }, test, {}, cache),
    ).toBe(true)
    expect(
      shouldRecord({ excludeSpecs: ['*checkout*'] }, test, {}, cache),
    ).toBe(false)
    expect(
      shouldRecord(
        { includeTags: ['@smoke'] },
        test,
        { tags: ['@regression'] },
        cache,
      ),
    ).toBe(false)
    expect(
      shouldRecord(
        { includeTags: ['@smoke'] },
        test,
        { tags: ['@smoke'] },
        cache,
      ),
    ).toBe(true)
    expect(
      shouldRecord(
        { excludeTags: ['@skip'] },
        test,
        { tags: ['@skip'] },
        cache,
      ),
    ).toBe(false)
    expect(
      shouldRecord(
        { excludeTags: ['@skip'] },
        test,
        { tags: ['@smoke'] },
        cache,
      ),
    ).toBe(true)
  })
})
