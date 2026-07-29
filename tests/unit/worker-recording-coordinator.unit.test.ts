import type { Frameworks } from '@wdio/types'
import { describe, expect, it, vi } from 'vitest'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import { normalizeTestEntity } from '../../src/service/recording-entity.js'
import {
  type RecordingAllurePort,
  type RecordingManifestPort,
  type WorkerRecordingActions,
  WorkerRecordingCoordinator,
} from '../../src/service/worker-recording-coordinator.js'
import type { WdioPuppeteerVideoServiceOptions } from '../../src/types.js'
import type { SlugMetadata } from '../../src/video-name-utils.js'

const createEntity = (
  title = 'records checkout',
  overrides: Partial<Frameworks.Test> = {},
  context: unknown = {},
) =>
  normalizeTestEntity(
    {
      type: 'test',
      title,
      fullTitle: `suite ${title}`,
      file: 'tests/specs/checkout.spec.ts',
      pending: false,
      ...overrides,
    } as Frameworks.Test,
    context,
    'mocha',
    'test',
  )

class FakeManifest implements RecordingManifestPort {
  currentEntryId: string | undefined
  readonly events: string[]
  readonly completed: unknown[] = []
  readonly attempts: number[] = []
  failRecordResult: Error | undefined

  constructor(events: string[]) {
    this.events = events
  }

  async beginEntity(input: { scope: 'spec' | 'test' }): Promise<string> {
    this.events.push(`manifest:begin:${input.scope}`)
    this.currentEntryId ??= 'entry-1'
    return this.currentEntryId
  }

  async completeCurrent(options: unknown): Promise<string | undefined> {
    this.events.push('manifest:complete')
    this.completed.push(options)
    const completedId = this.currentEntryId
    this.currentEntryId = undefined
    return completedId
  }

  async recordResult(result: string): Promise<void> {
    this.events.push(`manifest:result:${result}`)
    if (this.failRecordResult) {
      throw this.failRecordResult
    }
  }

  setCurrentAttempt(attempt: number): void {
    this.events.push(`manifest:attempt:${attempt.toString()}`)
    this.attempts.push(attempt)
  }
}

const createHarness = (
  serviceOptions: WdioPuppeteerVideoServiceOptions = {},
  harnessOptions: {
    availability?: { available: boolean; reason?: string }
    allureError?: Error
    finalizeError?: Error
    startError?: Error
    startResult?: boolean
  } = {},
) => {
  const events: string[] = []
  const manifest = new FakeManifest(events)
  const starts: Array<{
    metadata: Readonly<SlugMetadata>
    retryCount: number
  }> = []
  let active = false
  const paths = ['capture.webm']
  const actions: WorkerRecordingActions = {
    finalizeMedia: async (passed, keepArtifacts) => {
      events.push(
        `media:finalize:${passed.toString()}:${keepArtifacts.toString()}`,
      )
      if (harnessOptions.finalizeError) {
        throw harnessOptions.finalizeError
      }
      return { deferred: false, paths: keepArtifacts ? paths : [] }
    },
    getAvailability: () => harnessOptions.availability ?? { available: true },
    getRecordedPaths: () => paths,
    isRecordingActive: () => active,
    resetRecording: async () => {
      events.push('media:reset')
      active = false
    },
    runSerialized: async (task) => {
      events.push('serialized:begin')
      await task()
      events.push('serialized:end')
    },
    startRecording: async (metadata, retryCount) => {
      events.push(`media:start:${retryCount.toString()}`)
      starts.push({ metadata, retryCount })
      if (harnessOptions.startError) {
        throw harnessOptions.startError
      }
      const started = harnessOptions.startResult ?? true
      active = started
      return started
    },
  }
  const allure: RecordingAllurePort = {
    attachRetainedVideos: async (retainedPaths, passed) => {
      events.push(
        `allure:attach:${retainedPaths.join(',')}:${passed.toString()}`,
      )
      return {
        attachedPaths: [...retainedPaths],
        ...(harnessOptions.allureError
          ? { error: harnessOptions.allureError }
          : {}),
      }
    },
  }
  const log = vi.fn()
  const coordinator = new WorkerRecordingCoordinator({
    actions,
    allure,
    getLogLevel: () => 'trace',
    log,
    options: resolveServiceConfiguration(serviceOptions).options,
  })
  coordinator.configureSession({
    framework: 'mocha',
    manifest,
    specFileRetryAttempt: 0,
  })
  coordinator.beginWorker(['tests/specs/checkout.spec.ts'])

  return {
    coordinator,
    events,
    log,
    manifest,
    setActive(value: boolean) {
      active = value
    },
    starts,
  }
}

describe('worker recording coordinator', () => {
  it('infers retry-only attempts after eligibility and starts the retry', async () => {
    const harness = createHarness({ recording: { attempts: 'retries' } })
    const entity = createEntity()

    await harness.coordinator.beginEntity(entity)
    await harness.coordinator.beginEntity(entity)

    expect(harness.starts).toHaveLength(1)
    expect(harness.starts[0]).toMatchObject({
      retryCount: 1,
      metadata: { retryToken: '_retry1' },
    })
    expect(harness.manifest.completed[0]).toMatchObject({
      decision: 'skipped',
      reason: 'not-a-retry-attempt',
    })
    expect(harness.manifest.attempts).toEqual([1, 2])
    expect(harness.log).toHaveBeenCalledWith(
      'debug',
      expect.stringContaining('retryCount=0'),
    )
  })

  it.each([
    {
      name: 'framework retry',
      entity: createEntity('framework retry', { _currentRetry: 3 }),
      specRetry: 1,
      expected: 3,
    },
    {
      name: 'spec-file retry',
      entity: createEntity('spec retry'),
      specRetry: 2,
      expected: 2,
    },
  ])('preserves $name precedence', async (scenario) => {
    const harness = createHarness({ recording: { attempts: 'retries' } })
    harness.coordinator.configureSession({
      framework: 'mocha',
      manifest: harness.manifest,
      specFileRetryAttempt: scenario.specRetry,
    })

    await harness.coordinator.beginEntity(scenario.entity)

    expect(harness.starts[0]?.retryCount).toBe(scenario.expected)
    expect(harness.manifest.attempts).toEqual([scenario.expected + 1])
  })

  it.each([
    {
      name: 'unavailable recording',
      availability: { available: false, reason: 'missing CDP' },
      options: {},
      expectedReason: 'missing CDP',
      entity: createEntity(),
    },
    {
      name: 'spec filtering',
      availability: { available: true },
      options: {
        recording: { filters: { excludeSpecs: ['*checkout.spec.ts'] } },
      },
      expectedReason: 'filtered',
      entity: createEntity(),
    },
    {
      name: 'pending filtering',
      availability: { available: true },
      options: {
        recording: { filters: { excludeTags: ['@skip-video'] } },
      },
      expectedReason: 'filtered',
      entity: createEntity(
        'pending test',
        { pending: true },
        { tags: ['@skip-video'] },
      ),
      expectedResult: 'skipped',
    },
  ])('journals $name before starting media', async (scenario) => {
    const harness = createHarness(scenario.options, {
      availability: scenario.availability,
    })

    await harness.coordinator.beginEntity(scenario.entity)

    expect(harness.starts).toHaveLength(0)
    expect(harness.manifest.completed[0]).toMatchObject({
      decision: 'skipped',
      reason: scenario.expectedReason,
      result: scenario.expectedResult ?? 'unknown',
    })
  })

  it('aggregates spec results and finalizes one spec recording', async () => {
    const harness = createHarness({
      recording: { scope: 'spec', retain: 'failures' },
    })

    await harness.coordinator.beginEntity(createEntity('first test'))
    await harness.coordinator.beginEntity(createEntity('second test'))
    await harness.coordinator.endEntity({
      manifestResult: 'failed',
      passed: false,
    })
    await harness.coordinator.endEntity({
      manifestResult: 'passed',
      passed: true,
    })
    await harness.coordinator.finalizeSpecRecording()

    expect(harness.starts).toHaveLength(1)
    expect(
      harness.events.filter((event) => event.startsWith('media:finalize')),
    ).toEqual(['media:finalize:false:true'])
    expect(harness.manifest.completed).toHaveLength(1)
  })

  it('retains an active spec recording after a retry begins', async () => {
    const harness = createHarness({
      recording: { attempts: 'all', retain: 'retries', scope: 'spec' },
    })

    await harness.coordinator.beginEntity(createEntity('retried spec'))
    await harness.coordinator.endEntity({
      manifestResult: 'failed',
      passed: false,
    })
    await harness.coordinator.beginEntity(
      createEntity('retried spec', { _currentRetry: 1 }),
    )
    await harness.coordinator.endEntity({
      manifestResult: 'passed',
      passed: true,
    })
    await harness.coordinator.finalizeSpecRecording()

    expect(
      harness.events.filter((event) => event.startsWith('media:finalize')),
    ).toEqual(['media:finalize:false:true'])
  })

  it('leaves an active spec manifest open when a later entity is filtered', async () => {
    const harness = createHarness({
      recording: {
        scope: 'spec',
        filters: { excludeTags: ['@skip-video'] },
      },
    })

    await harness.coordinator.beginEntity(createEntity('recorded test'))
    await harness.coordinator.beginEntity(
      createEntity('filtered test', {}, { tags: ['@skip-video'] }),
    )

    expect(harness.starts).toHaveLength(1)
    expect(harness.manifest.completed).toHaveLength(0)
  })

  it('treats finalization without an active recording as a no-op', async () => {
    const harness = createHarness({ recording: { scope: 'spec' } })

    await expect(
      harness.coordinator.finalizeSpecRecording(),
    ).resolves.toBeUndefined()

    expect(harness.events).not.toContain('media:reset')
  })

  it('completes the manifest, attaches Allure, then resets recording state', async () => {
    const harness = createHarness({ recording: { retain: 'all' } })
    await harness.coordinator.beginEntity(createEntity())

    await harness.coordinator.endEntity({
      manifestResult: 'failed',
      passed: false,
    })

    const finalizationEvents = harness.events.filter(
      (event) =>
        event.startsWith('media:finalize') ||
        event === 'manifest:complete' ||
        event.startsWith('allure:attach') ||
        event === 'media:reset',
    )
    expect(finalizationEvents.slice(-4)).toEqual([
      'media:finalize:false:true',
      'manifest:complete',
      'allure:attach:capture.webm:false',
      'media:reset',
    ])
  })

  it('defers manifest result failures until media cleanup completes', async () => {
    const harness = createHarness({ recording: { retain: 'all' } })
    await harness.coordinator.beginEntity(createEntity())
    harness.manifest.failRecordResult = new Error('journal unavailable')

    await expect(
      harness.coordinator.endEntity({
        manifestResult: 'failed',
        passed: false,
      }),
    ).rejects.toThrow('journal unavailable')
    expect(harness.events).toContain('media:reset')
  })

  it('journals media failures, preserves recorded paths, and resets', async () => {
    const mediaError = new Error('merge failed')
    const harness = createHarness(
      { recording: { retain: 'all' } },
      { finalizeError: mediaError },
    )
    await harness.coordinator.beginEntity(createEntity())

    await expect(
      harness.coordinator.endEntity({
        manifestResult: 'failed',
        passed: false,
      }),
    ).rejects.toBe(mediaError)

    expect(harness.manifest.completed.at(-1)).toMatchObject({
      decision: 'failed',
      paths: ['capture.webm'],
      processingOutcome: 'failed',
      reason: 'merge failed',
    })
    expect(harness.events.at(-1)).toBe('media:reset')
  })

  it.each(['warn', 'error'] as const)(
    'applies Allure failures after reset with failurePolicy=%s',
    async (failurePolicy) => {
      const allureError = new Error('allure unavailable')
      const harness = createHarness(
        { failurePolicy, recording: { retain: 'all' } },
        { allureError },
      )
      await harness.coordinator.beginEntity(createEntity())
      const result = harness.coordinator.endEntity({
        manifestResult: 'passed',
        passed: true,
      })

      if (failurePolicy === 'error') {
        await expect(result).rejects.toBe(allureError)
      } else {
        await expect(result).resolves.toBeUndefined()
      }
      expect(harness.events.indexOf('media:reset')).toBeGreaterThan(
        harness.events.indexOf('allure:attach:capture.webm:true'),
      )
    },
  )

  it('journals and resets a failed recording start', async () => {
    const harness = createHarness({}, { startResult: false })

    await harness.coordinator.beginEntity(createEntity())

    expect(harness.manifest.completed[0]).toMatchObject({
      decision: 'failed',
      processingOperation: 'capture',
      reason: 'recording-start-failed',
    })
    expect(harness.events).toContain('media:reset')
  })

  it('applies error policy only after a failed start is journaled and reset', async () => {
    const harness = createHarness(
      { failurePolicy: 'error' },
      { startResult: false },
    )

    await expect(
      harness.coordinator.beginEntity(createEntity()),
    ).rejects.toThrow('recording-start-failed')
    expect(harness.manifest.completed[0]).toMatchObject({
      decision: 'failed',
      processingOperation: 'capture',
    })
    expect(harness.events.at(-1)).toBe('media:reset')
  })

  it('preserves a thrown start error until journaling and reset complete', async () => {
    const startError = new Error('capture setup failed')
    const harness = createHarness({}, { startError })

    await expect(harness.coordinator.beginEntity(createEntity())).rejects.toBe(
      startError,
    )
    expect(harness.manifest.completed[0]).toMatchObject({
      decision: 'failed',
      reason: 'capture setup failed',
    })
    expect(harness.events.at(-1)).toBe('media:reset')
  })

  it('resets attempt state between workers and exposes framework/scope', async () => {
    const harness = createHarness({ recording: { attempts: 'retries' } })
    expect(harness.coordinator.framework).toBe('mocha')
    expect(harness.coordinator.isSpecScope).toBe(false)
    await harness.coordinator.beginEntity(createEntity())
    harness.coordinator.resetWorkerState()
    harness.coordinator.beginWorker(['tests/specs/checkout.spec.ts'])
    await harness.coordinator.beginEntity(createEntity())

    expect(harness.starts).toHaveLength(0)
    expect(harness.manifest.completed).toHaveLength(2)
  })

  it('preserves spec identity when a session reload resets entity state', async () => {
    const harness = createHarness({ recording: { scope: 'spec' } })
    await harness.coordinator.beginEntity(createEntity('before reload'))
    harness.setActive(false)

    harness.coordinator.resetWorkerState()
    await harness.coordinator.beginEntity(createEntity('after reload'))

    expect(harness.starts.at(-1)?.metadata).toMatchObject({
      fileToken: 'checkout_spec',
      testNameToken: 'checkout_spec',
    })
  })
})
