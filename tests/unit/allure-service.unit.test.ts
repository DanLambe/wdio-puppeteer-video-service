import { describe, expect, it, vi } from 'vitest'
import WdioPuppeteerVideoService from '../../src/service.js'

interface FinalizeCallbacks {
  processArtifacts(): Promise<void>
  stopRecording(): Promise<void>
}

interface AllureServiceHarness {
  _allureIntegration: {
    attachRetainedVideos(
      paths: readonly string[],
      passed: boolean,
    ): Promise<{ attachedPaths: string[]; error?: Error }>
  }
  _currentTestSlug: string
  _finalizeCurrentTestRecording(passed: boolean): Promise<void>
  _manifestRecorder: {
    completeCurrent(options: unknown): Promise<void>
  }
  _recordedSegments: Set<string>
  _recordingLifecycle: {
    finalize(callbacks: FinalizeCallbacks): Promise<void>
  }
  _resetTestState(): Promise<void>
  _stopRecording(): Promise<void>
}

const createHarness = (failurePolicy: 'warn' | 'error') => {
  const service = new WdioPuppeteerVideoService({
    failurePolicy,
    integrations: { allure: {} },
  }) as unknown as AllureServiceHarness
  const events: string[] = []
  const attachmentError = new Error('allure write failed')
  const completeCurrent = vi.fn(async () => {})

  service._currentTestSlug = 'failed-test'
  service._recordedSegments.add('failed-test.mp4')
  service._recordingLifecycle = {
    finalize: async ({ stopRecording, processArtifacts }) => {
      await stopRecording()
      await processArtifacts()
    },
  }
  service._stopRecording = async () => {
    events.push('stop')
  }
  service._manifestRecorder = { completeCurrent }
  service._allureIntegration = {
    attachRetainedVideos: async (paths, passed) => {
      events.push(`attach:${paths.join(',')}:${passed.toString()}`)
      return { attachedPaths: [], error: attachmentError }
    },
  }
  service._resetTestState = async () => {
    events.push('reset')
    service._recordedSegments.clear()
    service._currentTestSlug = ''
  }

  return { attachmentError, completeCurrent, events, service }
}

describe('Allure service lifecycle', () => {
  it('keeps default integration failures non-fatal after attachment cleanup', async () => {
    const harness = createHarness('warn')

    await expect(
      harness.service._finalizeCurrentTestRecording(false),
    ).resolves.toBeUndefined()

    expect(harness.events).toEqual([
      'stop',
      'attach:failed-test.mp4:false',
      'reset',
    ])
    expect(harness.completeCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'recorded',
        paths: ['failed-test.mp4'],
        result: 'failed',
      }),
    )
  })

  it('applies error failure policy only after recording state is reset', async () => {
    const harness = createHarness('error')

    await expect(
      harness.service._finalizeCurrentTestRecording(false),
    ).rejects.toBe(harness.attachmentError)

    expect(harness.events.at(-1)).toBe('reset')
    expect(harness.service._currentTestSlug).toBe('')
    expect(harness.service._recordedSegments.size).toBe(0)
  })
})
