import { describe, expect, it } from 'vitest'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import WdioPuppeteerVideoService from '../../src/service.js'
import type { WdioPuppeteerVideoServiceOptions } from '../../src/types.js'

interface ConfigurationServiceProbe {
  _currentRecordingRetryCount: number
  _shouldKeepRecording: (passed: boolean) => boolean
}

describe('grouped 1.0 configuration API', () => {
  it('validates and resolves grouped options through the resolver contract', () => {
    const resolved = resolveServiceConfiguration({
      recording: { attempts: 'retries', retain: 'retries' },
    })

    expect(resolved.options.recording).toMatchObject({
      attempts: 'retries',
      retain: 'retries',
    })
  })

  it('rejects removed beta keys before any browser hook runs', () => {
    const betaOptions = {
      videoWidth: 1920,
    } as unknown as WdioPuppeteerVideoServiceOptions

    expect(() => new WdioPuppeteerVideoService(betaOptions)).toThrow(
      'Use "capture.viewport.width" instead',
    )
  })

  it('keeps capture attempts and artifact retention independent', () => {
    const retryRetention = new WdioPuppeteerVideoService({
      recording: { attempts: 'all', retain: 'retries' },
    }) as unknown as ConfigurationServiceProbe
    retryRetention._currentRecordingRetryCount = 0
    expect(retryRetention._shouldKeepRecording(false)).toBe(false)
    retryRetention._currentRecordingRetryCount = 1
    expect(retryRetention._shouldKeepRecording(true)).toBe(true)

    const failureRetention = new WdioPuppeteerVideoService({
      recording: { retain: 'failures' },
    }) as unknown as ConfigurationServiceProbe
    expect(failureRetention._shouldKeepRecording(true)).toBe(false)
    expect(failureRetention._shouldKeepRecording(false)).toBe(true)

    const allRetention = new WdioPuppeteerVideoService({
      recording: { retain: 'all' },
    }) as unknown as ConfigurationServiceProbe
    expect(allRetention._shouldKeepRecording(true)).toBe(true)
  })
})
