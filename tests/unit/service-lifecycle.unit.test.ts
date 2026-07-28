import { describe, expect, it, vi } from 'vitest'
import type { CaptureSession } from '../../src/service/capture-session.js'
import WdioPuppeteerVideoService from './characterized-service.js'

describe('WdioPuppeteerVideoService teardown lifecycle', () => {
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

    const tasks = [
      service.after(),
      service.afterSession(),
      service.onReload('old-session', 'new-session'),
    ]
    releaseStop?.()
    await Promise.all(tasks)

    expect(stopRecording).toHaveBeenCalledOnce()
    expect(resetTestState).toHaveBeenCalledOnce()
    expect(flushDeferredPostProcessTasks).toHaveBeenCalledOnce()
    expect(service._captureSession.currentTestSlug).toBe('')
    expect(service._captureSession.browser).toBeUndefined()
    expect(service._isChromium).toBe(false)
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
