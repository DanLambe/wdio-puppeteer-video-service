import { describe, expect, it } from 'vitest'
import { buildSpecRetryKey } from '../../src/service/retry-state.js'

describe('retry-state buildSpecRetryKey', () => {
  it('ignores dynamic capability fields for retry key matching', () => {
    const specs = ['tests/advanced/specs/spec-file-retry-recording.spec.ts']
    const launcherCapabilities = {
      browserName: 'chrome',
      browserVersion: '131',
      platformName: 'Windows',
      'goog:chromeOptions': {
        args: ['--user-data-dir=C:/tmp/wdio-profile-a'],
        prefs: {
          'download.default_directory': 'C:/tmp/downloads-a',
        },
      },
      'wdio:chromedriverOptions': {
        port: 9515,
      },
    } as unknown as WebdriverIO.Capabilities
    const workerCapabilities = {
      browserName: 'chrome',
      browserVersion: '131',
      platformName: 'Windows',
      'goog:chromeOptions': {
        args: ['--user-data-dir=C:/tmp/wdio-profile-b'],
        prefs: {
          'download.default_directory': 'C:/tmp/downloads-b',
        },
      },
      'wdio:chromedriverOptions': {
        port: 9516,
      },
      'custom:ephemeralToken': 'run-2',
    } as unknown as WebdriverIO.Capabilities

    const launcherKey = buildSpecRetryKey(specs, launcherCapabilities)
    const workerKey = buildSpecRetryKey(specs, workerCapabilities)

    expect(workerKey).toBe(launcherKey)
  })

  it('changes key when static browser identity changes', () => {
    const specs = ['tests/advanced/specs/spec-file-retry-recording.spec.ts']
    const chromeCaps = {
      browserName: 'chrome',
      platformName: 'Windows',
    } as unknown as WebdriverIO.Capabilities
    const edgeCaps = {
      browserName: 'MicrosoftEdge',
      platformName: 'Windows',
    } as unknown as WebdriverIO.Capabilities

    const chromeKey = buildSpecRetryKey(specs, chromeCaps)
    const edgeKey = buildSpecRetryKey(specs, edgeCaps)

    expect(edgeKey).not.toBe(chromeKey)
  })

  it('uses stable appium fields and ignores dynamic appium options', () => {
    const specs = ['tests/advanced/specs/spec-file-retry-recording.spec.ts']
    const firstCaps = {
      'appium:options': {
        automationName: 'UiAutomator2',
        deviceName: 'Pixel 8',
        newCommandTimeout: 30,
      },
      platformName: 'Android',
    } as unknown as WebdriverIO.Capabilities
    const secondCaps = {
      'appium:options': {
        automationName: 'UiAutomator2',
        deviceName: 'Pixel 8',
        newCommandTimeout: 120,
      },
      platformName: 'Android',
    } as unknown as WebdriverIO.Capabilities
    const changedStaticCaps = {
      'appium:options': {
        automationName: 'UiAutomator2',
        deviceName: 'Pixel 9',
        newCommandTimeout: 120,
      },
      platformName: 'Android',
    } as unknown as WebdriverIO.Capabilities

    const firstKey = buildSpecRetryKey(specs, firstCaps)
    const secondKey = buildSpecRetryKey(specs, secondCaps)
    const changedStaticKey = buildSpecRetryKey(specs, changedStaticCaps)

    expect(secondKey).toBe(firstKey)
    expect(changedStaticKey).not.toBe(firstKey)
  })

  it('sorts specs before building the key', () => {
    const capabilities = {
      browserName: 'chrome',
    } as unknown as WebdriverIO.Capabilities
    const orderedSpecs = ['tests/specs/a.test.ts', 'tests/specs/b.test.ts']
    const reversedSpecs = ['tests/specs/b.test.ts', 'tests/specs/a.test.ts']

    const orderedKey = buildSpecRetryKey(orderedSpecs, capabilities)
    const reversedKey = buildSpecRetryKey(reversedSpecs, capabilities)

    expect(reversedKey).toBe(orderedKey)
  })
})
