import { describe, expect, it } from 'vitest'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import { shouldRetainRecording } from '../../src/service/recording-policy.js'
import WdioPuppeteerVideoService from '../../src/service.js'
import type { WdioPuppeteerVideoServiceOptions } from '../../src/types.js'

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
    const retryRetention = resolveServiceConfiguration({
      recording: { attempts: 'all', retain: 'retries' },
    }).options.recording
    expect(
      shouldRetainRecording({
        retain: retryRetention.retain,
        passed: false,
        retryCount: 0,
      }),
    ).toBe(false)
    expect(
      shouldRetainRecording({
        retain: retryRetention.retain,
        passed: true,
        retryCount: 1,
      }),
    ).toBe(true)

    expect(
      shouldRetainRecording({
        retain: 'failures',
        passed: true,
        retryCount: 0,
      }),
    ).toBe(false)
    expect(
      shouldRetainRecording({
        retain: 'failures',
        passed: false,
        retryCount: 0,
      }),
    ).toBe(true)
    expect(
      shouldRetainRecording({
        retain: 'all',
        passed: true,
        retryCount: 0,
      }),
    ).toBe(true)
  })
})
