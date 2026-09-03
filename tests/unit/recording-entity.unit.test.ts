import type { Frameworks } from '@wdio/types'
import { describe, expect, it } from 'vitest'
import {
  extractExplicitRetryCount,
  extractFrameworkEntityId,
  normalizeScenarioEntity,
  normalizeScenarioOutcome,
  normalizeTestEntity,
  normalizeTestOutcome,
} from '../../src/service/recording-entity.js'

const createTest = (
  overrides: Partial<Frameworks.Test> = {},
): Frameworks.Test =>
  ({
    type: 'test',
    title: 'adds an item',
    fullTitle: 'checkout adds an item',
    file: 'tests/specs/checkout.spec.ts',
    pending: false,
    ...overrides,
  }) as Frameworks.Test

describe('recording entity normalization', () => {
  it.each(['mocha', 'jasmine'] as const)(
    'normalizes %s test identity, tags, retry metadata, and slug input',
    (framework) => {
      const test = createTest()
      const context = {
        currentTest: { _currentRetry: 2 },
        tags: [{ name: '@Smoke' }, '@checkout'],
      }
      const entity = normalizeTestEntity(test, context, framework, 'test-full')

      expect(entity).toMatchObject({
        framework,
        kind: 'test',
        label: 'adds an item',
        manifestResultWhenSkipped: 'unknown',
        pending: false,
        specPath: 'tests/specs/checkout.spec.ts',
        tags: ['@smoke', '@checkout'],
        explicitFrameworkRetry: 2,
      })
      expect(entity.manifestTest).toBe(test)
      expect(entity.slugMetadata.testNameToken).toBe('checkout_adds_an_item')
      expect(Object.isFrozen(entity)).toBe(true)
      expect(Object.isFrozen(entity.slugMetadata)).toBe(true)
      expect(Object.isFrozen(entity.tags)).toBe(true)
    },
  )

  it('normalizes Cucumber scenarios without changing the historical slug inputs', () => {
    const world = {
      pickle: { name: 'customer retries checkout' },
    } as Frameworks.World
    const context = {
      uri: 'features/checkout.feature',
      pickle: {
        tags: [{ name: '@Retry' }],
      },
      _currentRetry: 1,
    }
    const entity = normalizeScenarioEntity(world, context, 'test')

    expect(entity).toMatchObject({
      framework: 'cucumber',
      kind: 'scenario',
      label: 'customer retries checkout',
      manifestResultWhenSkipped: 'unknown',
      specPath: 'features/checkout.feature',
      tags: ['@retry'],
      explicitFrameworkRetry: 1,
    })
    expect(entity.manifestTest).toMatchObject({
      title: 'customer retries checkout',
      fullTitle: 'customer retries checkout',
    })
    expect(entity.slugMetadata.testNameToken).toBe('customer_retries_checkout')
  })

  it('uses the world as Cucumber context only when WDIO omits context', () => {
    const world = {
      pickle: {
        name: 'tagged scenario',
        tags: [{ name: '@world' }],
      },
    } as Frameworks.World

    expect(normalizeScenarioEntity(world, undefined, 'test').context).toBe(
      world,
    )
  })

  it('uses stable fallback labels when a framework omits titles', () => {
    expect(
      normalizeTestEntity(
        createTest({ title: '', fullTitle: 'fallback full title' }),
        {},
        'jasmine',
        'test',
      ).label,
    ).toBe('fallback full title')
    expect(
      normalizeTestEntity(
        createTest({ title: '', fullTitle: '' }),
        {},
        'mocha',
        'test',
      ).label,
    ).toBe('test')
    expect(
      normalizeScenarioEntity({} as Frameworks.World, undefined, 'test').label,
    ).toBe('scenario')
  })

  it('preserves skipped test and framework outcome semantics', () => {
    const pending = createTest({ pending: true })
    expect(normalizeTestEntity(pending, {}, 'mocha', 'test')).toMatchObject({
      pending: true,
      manifestResultWhenSkipped: 'skipped',
    })
    expect(
      normalizeTestOutcome(pending, { passed: false } as Frameworks.TestResult),
    ).toEqual({ manifestResult: 'skipped', passed: false })
    expect(
      normalizeTestOutcome(createTest(), {
        passed: true,
      } as Frameworks.TestResult),
    ).toEqual({ manifestResult: 'passed', passed: true })
    expect(
      normalizeScenarioOutcome({ passed: false } as Frameworks.PickleResult),
    ).toEqual({ manifestResult: 'failed', passed: false })
  })

  it('prefers test, context, then current-test retries and rejects invalid values', () => {
    expect(
      extractExplicitRetryCount(createTest({ _currentRetry: 3 }), {
        _currentRetry: 2,
        currentTest: { _currentRetry: 1 },
      }),
    ).toBe(3)
    expect(
      extractExplicitRetryCount(createTest(), {
        _currentRetry: 2.9,
        currentTest: { _currentRetry: 1 },
      }),
    ).toBe(2)
    expect(
      extractExplicitRetryCount(createTest(), {
        currentTest: { _currentRetry: 1 },
      }),
    ).toBe(1)

    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, '1']) {
      expect(
        extractExplicitRetryCount(createTest(), { _currentRetry: value }),
      ).toBeUndefined()
    }
  })

  it('captures the framework-assigned entity id when one is available', () => {
    const scenario = normalizeScenarioEntity(
      {
        pickle: { id: 'pickle-7', name: 'customer retries checkout' },
      } as Frameworks.World,
      { uri: 'features/checkout.feature' },
      'test',
    )
    expect(scenario.frameworkEntityId).toBe('pickle-7')

    // Jasmine surfaces a unique spec result id; Mocha exposes none.
    expect(
      normalizeTestEntity(
        createTest({ id: 'spec3' } as Partial<Frameworks.Test>),
        {},
        'jasmine',
        'test',
      ).frameworkEntityId,
    ).toBe('spec3')
    expect(
      normalizeTestEntity(createTest(), {}, 'mocha', 'test').frameworkEntityId,
    ).toBeUndefined()
    expect(
      normalizeScenarioEntity({} as Frameworks.World, undefined, 'test')
        .frameworkEntityId,
    ).toBeUndefined()
  })

  it('ignores framework entity ids that are not usable strings', () => {
    for (const identifier of [undefined, null, '', '   ', 7, {}]) {
      expect(extractFrameworkEntityId({ id: identifier })).toBeUndefined()
    }
    expect(extractFrameworkEntityId(undefined)).toBeUndefined()
    expect(extractFrameworkEntityId('pickle-1')).toBeUndefined()
    expect(extractFrameworkEntityId({ id: '  pickle-2  ' })).toBe('pickle-2')
  })
})
