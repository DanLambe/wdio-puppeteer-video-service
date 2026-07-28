import type { Frameworks } from '@wdio/types'
import { describe, expect, it, vi } from 'vitest'
import type { WorkerRecordingCoordinatorPort } from '../../src/service/worker-recording-coordinator.js'
import WdioPuppeteerVideoService from '../../src/service.js'

const createCoordinator = (): WorkerRecordingCoordinatorPort => ({
  framework: 'mocha',
  isSpecScope: false,
  beginEntity: vi.fn(async () => {}),
  beginWorker: vi.fn(),
  configureSession: vi.fn(),
  endEntity: vi.fn(async () => {}),
  finalizeSpecRecording: vi.fn(async () => {}),
  resetWorkerState: vi.fn(),
})

const createService = (coordinator: WorkerRecordingCoordinatorPort) =>
  new WdioPuppeteerVideoService({}, undefined, undefined, {
    createRecordingCoordinator: () => coordinator,
  })

describe('worker service recording coordinator adapter', () => {
  it('normalizes Mocha entities and outcomes before delegating', async () => {
    const coordinator = createCoordinator()
    const service = createService(coordinator)
    const test = {
      type: 'test',
      title: 'records checkout',
      fullTitle: 'checkout records checkout',
      file: 'tests/specs/checkout.spec.ts',
      pending: false,
    } as unknown as Frameworks.Test

    await service.beforeTest(test, {
      currentTest: { _currentRetry: 1 },
      tenant: 'demo',
    })
    await service.afterTest(test, {}, {
      passed: false,
    } as Frameworks.TestResult)

    expect(coordinator.beginEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        framework: 'mocha',
        kind: 'test',
        label: 'records checkout',
        explicitFrameworkRetry: 1,
      }),
    )
    expect(coordinator.endEntity).toHaveBeenCalledWith({
      manifestResult: 'failed',
      passed: false,
    })
  })

  it('normalizes Cucumber entities and outcomes before delegating', async () => {
    const coordinator = createCoordinator()
    const service = createService(coordinator)
    const world = {
      pickle: {
        name: 'submits an order',
        tags: [{ name: '@checkout' }],
        uri: 'tests/features/checkout.feature',
      },
    } as unknown as Frameworks.World

    await service.beforeScenario(world, {
      pickle: { tags: [{ name: '@checkout' }] },
      tenant: 'demo',
      uri: 'tests/features/checkout.feature',
    })
    await service.afterScenario(world, {
      passed: true,
    } as Frameworks.PickleResult)

    expect(coordinator.beginEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        framework: 'cucumber',
        kind: 'scenario',
        label: 'submits an order',
        tags: ['@checkout'],
      }),
    )
    expect(coordinator.endEntity).toHaveBeenCalledWith({
      manifestResult: 'passed',
      passed: true,
    })
  })

  it('starts the coordinator before applying browser support checks', async () => {
    const coordinator = createCoordinator()
    const service = createService(coordinator)
    const specs = ['tests/specs/firefox.spec.ts']
    const browser = {
      capabilities: { browserName: 'firefox' },
      isMultiremote: false,
      sessionId: 'firefox-session',
    } as unknown as Parameters<WdioPuppeteerVideoService['before']>[2]

    await service.before({ browserName: 'firefox' }, specs, browser)

    expect(coordinator.beginWorker).toHaveBeenCalledWith(specs)
  })
})
