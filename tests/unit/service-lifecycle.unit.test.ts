import { describe, expect, it, vi } from 'vitest'
import type {
  RecordingCoordinatorFactory,
  WorkerRecordingCoordinatorPort,
} from '../../src/service/worker-recording-coordinator.js'
import WdioPuppeteerVideoService from '../../src/service.js'

const createCoordinator = (
  resetWorkerState: () => void,
): WorkerRecordingCoordinatorPort => ({
  framework: 'unknown',
  isSpecScope: false,
  beginEntity: vi.fn(async () => {}),
  beginWorker: vi.fn(),
  configureSession: vi.fn(),
  endEntity: vi.fn(async () => {}),
  finalizeSpecRecording: vi.fn(async () => {}),
  resetWorkerState,
})

const createService = (
  createRecordingCoordinator: RecordingCoordinatorFactory,
): WdioPuppeteerVideoService => {
  return new WdioPuppeteerVideoService(
    { failurePolicy: 'error', logLevel: 'silent' },
    undefined,
    undefined,
    { createRecordingCoordinator },
  )
}

describe('WdioPuppeteerVideoService teardown lifecycle', () => {
  it('deduplicates concurrent teardown hooks and permits later cleanup', async () => {
    const resetWorkerState = vi.fn()
    const service = createService(() => createCoordinator(resetWorkerState))

    await Promise.all([service.after(), service.afterSession()])
    expect(resetWorkerState).toHaveBeenCalledOnce()

    await service.after()
    await service.onReload('old-session', 'new-session')
    expect(resetWorkerState).toHaveBeenCalledTimes(3)
  })

  it('clears a rejected teardown task so a later hook can retry cleanup', async () => {
    const resetWorkerState = vi.fn<() => void>().mockImplementationOnce(() => {
      throw new Error('first teardown failed')
    })
    const service = createService(() => createCoordinator(resetWorkerState))

    await expect(service.after()).rejects.toThrow('first teardown failed')
    await expect(service.after()).resolves.toBeUndefined()
    expect(resetWorkerState).toHaveBeenCalledTimes(2)
  })
})
