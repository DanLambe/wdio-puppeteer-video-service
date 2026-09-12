import type { Frameworks } from '@wdio/types'
import { describe, expect, it } from 'vitest'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import {
  normalizeScenarioEntity,
  normalizeTestEntity,
} from '../../src/service/recording-entity.js'
import {
  applyRetryCountToMetadata,
  buildSpecLevelSlugMetadata,
  createCompletedManifestOptions,
  createRetryTrackingKey,
  decideRecordingStart,
  evaluateRecordingEligibility,
  resolveProcessingOperation,
  resolveRecordingAttempt,
  shouldRetainRecording,
} from '../../src/service/recording-policy.js'

const createEntity = (
  overrides: Partial<Frameworks.Test> = {},
  context: unknown = {},
) =>
  normalizeTestEntity(
    {
      type: 'test',
      title: 'adds an item',
      fullTitle: 'checkout adds an item',
      file: 'tests/specs/checkout.spec.ts',
      pending: false,
      ...overrides,
    } as Frameworks.Test,
    context,
    'mocha',
    'test',
  )

describe('recording policy', () => {
  it.each([
    {
      name: 'unavailable worker',
      availability: { available: false, reason: 'missing CDP' },
      filters: {},
      expected: { eligible: false, reason: 'missing CDP' },
    },
    {
      name: 'default unavailable reason',
      availability: { available: false },
      filters: {},
      expected: {
        eligible: false,
        reason: 'recording-hooks-unavailable',
      },
    },
    {
      name: 'excluded spec',
      availability: { available: true },
      filters: { excludeSpecs: ['*checkout.spec.ts'] },
      expected: { eligible: false, reason: 'filtered' },
    },
    {
      name: 'included tag',
      availability: { available: true },
      filters: { includeTags: ['@smoke'] },
      context: { tags: ['@smoke'] },
      expected: { eligible: true },
    },
  ])('evaluates $name before retry state changes', (scenario) => {
    const entity = createEntity({}, scenario.context)
    expect(
      evaluateRecordingEligibility(
        entity,
        scenario.availability,
        scenario.filters,
        new Map(),
      ),
    ).toEqual(scenario.expected)
  })

  it.each([
    {
      explicitFrameworkRetry: undefined,
      specFileRetryAttempt: 0,
      inferredEntityRetry: undefined,
      expected: 0,
    },
    {
      explicitFrameworkRetry: 3,
      specFileRetryAttempt: 1,
      inferredEntityRetry: 2,
      expected: 3,
    },
    {
      explicitFrameworkRetry: 1,
      specFileRetryAttempt: 4,
      inferredEntityRetry: 2,
      expected: 4,
    },
    {
      explicitFrameworkRetry: 1,
      specFileRetryAttempt: 2,
      inferredEntityRetry: 5,
      expected: 5,
    },
  ])('uses the highest available retry source %#', (scenario) => {
    const entity = createEntity({
      ...(scenario.explicitFrameworkRetry === undefined
        ? {}
        : { _currentRetry: scenario.explicitFrameworkRetry }),
    })
    expect(
      resolveRecordingAttempt({
        entity,
        inferredEntityRetry: scenario.inferredEntityRetry,
        specFileRetryAttempt: scenario.specFileRetryAttempt,
      }),
    ).toMatchObject({
      effectiveRetryCount: scenario.expected,
      explicitFrameworkRetry: scenario.explicitFrameworkRetry,
      inferredEntityRetry: scenario.inferredEntityRetry,
      specFileRetryAttempt: scenario.specFileRetryAttempt,
    })
  })

  it('decides retry skips, test starts, spec starts, and active-spec reuse', () => {
    const entity = createEntity()
    const initialAttempt = resolveRecordingAttempt({
      entity,
      inferredEntityRetry: 0,
      specFileRetryAttempt: 0,
    })
    expect(
      decideRecordingStart({
        attempts: 'retries',
        entity,
        retryContext: initialAttempt,
        scope: 'test',
        specPaths: [],
        specRecordingActive: false,
      }),
    ).toMatchObject({ action: 'skip', reason: 'not-a-retry-attempt' })

    const retryAttempt = { ...initialAttempt, effectiveRetryCount: 2 }
    expect(
      decideRecordingStart({
        attempts: 'all',
        entity,
        retryContext: retryAttempt,
        scope: 'test',
        specPaths: [],
        specRecordingActive: false,
      }),
    ).toMatchObject({
      action: 'start',
      metadata: { retryToken: '_retry2' },
    })
    expect(
      decideRecordingStart({
        attempts: 'all',
        entity,
        retryContext: retryAttempt,
        scope: 'spec',
        specPaths: ['tests/specs/checkout.spec.ts'],
        specRecordingActive: false,
      }),
    ).toMatchObject({
      action: 'start',
      metadata: {
        fileToken: 'checkout_spec',
        testNameToken: 'checkout_spec',
        retryToken: '_retry2',
      },
    })
    expect(
      decideRecordingStart({
        attempts: 'all',
        entity,
        retryContext: retryAttempt,
        scope: 'spec',
        specPaths: ['tests/specs/checkout.spec.ts'],
        specRecordingActive: true,
      }),
    ).toMatchObject({ action: 'continue-spec' })
  })

  it('keys retry tracking on a framework entity id when one exists', () => {
    const withoutIdentifier = createEntity()
    const firstScenario = normalizeScenarioEntity(
      { pickle: { id: 'pickle-a', name: 'shared name' } } as Frameworks.World,
      { uri: 'features/checkout.feature' },
      'test',
    )
    const retriedScenario = normalizeScenarioEntity(
      { pickle: { id: 'pickle-a', name: 'shared name' } } as Frameworks.World,
      { uri: 'features/checkout.feature' },
      'test',
    )
    const sameNameScenario = normalizeScenarioEntity(
      { pickle: { id: 'pickle-b', name: 'shared name' } } as Frameworks.World,
      { uri: 'features/checkout.feature' },
      'test',
    )

    // A retry reuses its pickle id, so it must resolve to the same key.
    expect(createRetryTrackingKey(retriedScenario)).toBe(
      createRetryTrackingKey(firstScenario),
    )
    // A distinct scenario that happens to share a name must not.
    expect(createRetryTrackingKey(sameNameScenario)).not.toBe(
      createRetryTrackingKey(firstScenario),
    )
    expect(createRetryTrackingKey(firstScenario)).toBe(
      'framework-id|features/checkout.feature|pickle-a',
    )
    expect(createRetryTrackingKey(withoutIdentifier)).toContain(
      'checkout_spec|adds_an_item|',
    )
  })

  it('builds deterministic retry and multi-spec slug metadata', () => {
    const entity = createEntity()
    expect(createRetryTrackingKey(entity)).toContain(
      'checkout_spec|adds_an_item|',
    )
    expect(applyRetryCountToMetadata(entity.slugMetadata, 0)).toMatchObject({
      retryToken: '',
    })
    expect(applyRetryCountToMetadata(entity.slugMetadata, 2)).toMatchObject({
      retryToken: '_retry2',
      hashInput: expect.stringContaining('|retry=2'),
    })
    expect(
      buildSpecLevelSlugMetadata(
        ['tests/specs/checkout.spec.ts', 'tests/specs/cart.spec.ts'],
        2,
      ),
    ).toEqual({
      fileToken: 'checkout_spec',
      testNameToken: 'checkout_spec',
      retryToken: '_retry2',
      hashInput: 'spec|tests/specs/checkout.spec.ts|tests/specs/cart.spec.ts|2',
    })
    expect(buildSpecLevelSlugMetadata([], 0)).toEqual({
      fileToken: 'spec',
      testNameToken: 'spec_spec',
      retryToken: '',
      hashInput: 'spec|spec|0',
    })
  })

  it.each([
    ['all', true, 0, true],
    ['all', false, 0, true],
    ['failures', true, 0, false],
    ['failures', false, 0, true],
    ['retries', true, 0, false],
    ['retries', true, 1, true],
    ['retries', false, 0, false],
  ] as const)(
    'applies retain=%s passed=%s retry=%i',
    (retain, passed, retryCount, expected) => {
      expect(shouldRetainRecording({ passed, retain, retryCount })).toBe(
        expected,
      )
    },
  )

  it('builds manifest completion decisions for retention and processing', () => {
    const baseProcessing = resolveServiceConfiguration().options.processing
    expect(
      createCompletedManifestOptions({
        deferred: false,
        keepArtifacts: false,
        result: 'passed',
        paths: [],
        processing: baseProcessing,
      }),
    ).toMatchObject({
      decision: 'discarded',
      processingOutcome: 'skipped',
      reason: 'retention-policy',
      result: 'passed',
    })

    const mergeProcessing = resolveServiceConfiguration({
      processing: { merge: { enabled: true } },
    }).options.processing
    expect(resolveProcessingOperation(mergeProcessing)).toBe('merge')
    expect(
      createCompletedManifestOptions({
        deferred: true,
        keepArtifacts: true,
        result: 'failed',
        paths: ['capture.webm'],
        processing: mergeProcessing,
      }),
    ).toMatchObject({
      decision: 'recorded',
      processingOperation: 'merge',
      processingOutcome: 'pending',
      result: 'failed',
    })

    const transcodeProcessing = resolveServiceConfiguration({
      processing: { transcode: { enabled: true } },
    }).options.processing
    expect(resolveProcessingOperation(transcodeProcessing)).toBe('transcode')
    expect(resolveProcessingOperation(baseProcessing)).toBeUndefined()
    expect(
      createCompletedManifestOptions({
        deferred: false,
        keepArtifacts: true,
        result: 'passed',
        paths: [],
        processing: baseProcessing,
      }),
    ).toMatchObject({
      decision: 'failed',
      processingOutcome: 'not-required',
      result: 'passed',
    })
    expect(
      createCompletedManifestOptions({
        deferred: false,
        keepArtifacts: true,
        result: 'passed',
        paths: ['capture.mp4'],
        processing: transcodeProcessing,
      }),
    ).toMatchObject({
      decision: 'recorded',
      processingOperation: 'transcode',
      processingOutcome: 'completed',
    })
  })
})
