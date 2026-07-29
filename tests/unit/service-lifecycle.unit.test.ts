import { describe, expect, it, vi } from 'vitest'
import type { CaptureSession } from '../../src/service/capture-session.js'
import type { FfmpegRuntime } from '../../src/service/ffmpeg-runtime.js'
import WdioPuppeteerVideoService from './characterized-service.js'

describe('WdioPuppeteerVideoService teardown lifecycle', () => {
  it('awaits and deduplicates process termination before teardown work', async () => {
    let releaseTermination: (() => void) | undefined
    const terminationGate = new Promise<void>((resolve) => {
      releaseTermination = resolve
    })
    const service = new WdioPuppeteerVideoService({
      logLevel: 'silent',
    }) as unknown as {
      _ffmpegRuntime: Pick<
        FfmpegRuntime,
        'releaseHeldPostProcessSlots' | 'resumeAfterTeardown' | 'terminateAll'
      >
      _flushDeferredPostProcessTasks: () => Promise<void>
      after: () => Promise<void>
      afterSession: () => Promise<void>
    }
    const callOrder: string[] = []
    const terminateAll = vi.fn(async () => {
      callOrder.push('terminate-start')
      await terminationGate
      callOrder.push('terminate-end')
    })
    const resumeAfterTeardown = vi.fn(() => {
      callOrder.push('resume')
    })
    const releaseHeldPostProcessSlots = vi.fn(async () => {
      callOrder.push('release')
    })
    const flushDeferredPostProcessTasks = vi.fn(async () => {
      callOrder.push('flush')
    })
    service._ffmpegRuntime.terminateAll = terminateAll
    service._ffmpegRuntime.resumeAfterTeardown = resumeAfterTeardown
    service._ffmpegRuntime.releaseHeldPostProcessSlots =
      releaseHeldPostProcessSlots
    service._flushDeferredPostProcessTasks = flushDeferredPostProcessTasks

    const firstTeardown = service.after()
    const concurrentTeardown = service.afterSession()
    await vi.waitFor(() => {
      expect(terminateAll).toHaveBeenCalledOnce()
    })
    expect(flushDeferredPostProcessTasks).not.toHaveBeenCalled()

    releaseTermination?.()
    await Promise.all([firstTeardown, concurrentTeardown])
    expect(terminateAll).toHaveBeenCalledTimes(2)
    expect(flushDeferredPostProcessTasks).toHaveBeenCalledOnce()
    expect(callOrder).toEqual([
      'terminate-start',
      'terminate-end',
      'resume',
      'flush',
      'terminate-start',
      'terminate-end',
      'release',
    ])
  })

  it('runs concurrent and repeated teardown hooks once without retaining state', async () => {
    let releaseStop: (() => void) | undefined
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    const service = new WdioPuppeteerVideoService({
      logLevel: 'silent',
    }) as unknown as {
      _captureSession: CaptureSession
      _flushDeferredPostProcessTasks: () => Promise<void>
      _isChromium: boolean
      _recordingSlotScheduler: {
        ownsGlobalRecordingSlot: boolean
        ownsRecordingSlot: boolean
      }
      _resetTestState: () => Promise<void>
      _sessionIdToken: string
      _stopRecording: () => Promise<void>
      after: () => Promise<void>
      afterSession: () => Promise<void>
      onReload: (oldSessionId: string, newSessionId: string) => Promise<void>
    }
    const stopRecording = vi.fn(async () => {
      await stopGate
    })
    const resetTestState = vi.fn(async () => {
      service._captureSession.resetRecording()
    })
    const flushDeferredPostProcessTasks = vi.fn(async () => {})
    service._captureSession.setBrowser({} as never)
    service._captureSession.beginRecording('interrupted-test')
    service._isChromium = true
    service._recordingSlotScheduler = {
      ownsGlobalRecordingSlot: false,
      ownsRecordingSlot: false,
    }
    service._stopRecording = stopRecording
    service._resetTestState = resetTestState
    service._flushDeferredPostProcessTasks = flushDeferredPostProcessTasks

    const tasks = [service.after(), service.afterSession()]
    releaseStop?.()
    await Promise.all(tasks)

    expect(stopRecording).toHaveBeenCalledOnce()
    expect(resetTestState).toHaveBeenCalledOnce()
    expect(flushDeferredPostProcessTasks).toHaveBeenCalledOnce()
    expect(service._captureSession.currentTestSlug).toBe('')
    expect(service._captureSession.browser).toBeUndefined()
    expect(service._isChromium).toBe(false)

    await service.onReload('old-session', 'new-session')
    expect(service._sessionIdToken).not.toBe('')

    await service.after()
    await service.afterSession()
    expect(stopRecording).toHaveBeenCalledOnce()
    expect(resetTestState).toHaveBeenCalledOnce()
  })

  it('clears a rejected teardown task so a later hook can retry cleanup', async () => {
    const service = new WdioPuppeteerVideoService({
      failurePolicy: 'error',
      logLevel: 'silent',
    }) as unknown as {
      _flushDeferredPostProcessTasks: () => Promise<void>
      _teardownTask: Promise<void> | undefined
      after: () => Promise<void>
    }
    const flushDeferredPostProcessTasks = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('first teardown failed'))
      .mockResolvedValue(undefined)
    service._flushDeferredPostProcessTasks = flushDeferredPostProcessTasks

    await expect(service.after()).rejects.toThrow('first teardown failed')
    expect(service._teardownTask).toBeUndefined()

    await expect(service.after()).resolves.toBeUndefined()
    expect(flushDeferredPostProcessTasks).toHaveBeenCalledTimes(2)
  })
})
