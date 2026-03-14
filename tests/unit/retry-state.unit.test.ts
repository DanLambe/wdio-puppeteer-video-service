import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildSpecRetryKey,
  extractPidFromSlotFile,
  getSpecRetryStateDirPath,
  getSpecRetryStatePathForCid,
  isProcessAlive,
  resolveGlobalRecordingLockDir,
} from '../../src/service/retry-state.js'

describe('retry-state buildSpecRetryKey', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

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

  it('falls back to a generic capability fingerprint when capabilities are not an object', () => {
    const key = buildSpecRetryKey(
      ['tests/specs/retry.test.ts'],
      null as unknown as WebdriverIO.Capabilities,
    )

    expect(key).toContain('capabilities|')
  })

  it('collects static tokens from nested capability sources without overriding the first value', () => {
    const key = buildSpecRetryKey(
      ['tests/specs/retry.test.ts'],
      {
        alwaysMatch: {
          browserName: 'Chrome',
        },
        firstMatch: [
          {
            platformName: 'LINUX',
          },
          {
            'appium:options': {
              automationName: 'UiAutomator2',
              deviceName: 'Pixel 8',
              platformVersion: 15,
            },
          },
        ],
        capabilities: {
          browserVersion: '131',
          firstMatch: [
            {
              browserName: 'Edge',
              platform: true,
            },
          ],
        },
      } as unknown as WebdriverIO.Capabilities,
    )

    expect(key).toContain('browserName:chrome')
    expect(key).toContain('browserVersion:131')
    expect(key).toContain('platformName:linux')
    expect(key).toContain('platform:true')
    expect(key).toContain('appium:options.automationName:uiautomator2')
    expect(key).toContain('appium:options.deviceName:pixel 8')
    expect(key).toContain('appium:options.platformVersion:15')
    expect(key).not.toContain('browserName:edge')
  })
})

describe('retry-state helper utilities', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('builds retry-state paths using custom and default output directories', () => {
    expect(getSpecRetryStateDirPath('artifacts')).toBe(
      path.join('artifacts', '.wdio-video-retry-state'),
    )
    expect(getSpecRetryStateDirPath(undefined)).toBe(
      path.join('videos', '.wdio-video-retry-state'),
    )
    expect(getSpecRetryStatePathForCid('artifacts', ' 0:1/2 ')).toBe(
      path.join('artifacts', '.wdio-video-retry-state', '0_1_2.json'),
    )
    expect(getSpecRetryStatePathForCid(undefined, '   ')).toBe(
      path.join('videos', '.wdio-video-retry-state', 'unknown.json'),
    )
  })

  it('resolves the global recording lock directory with trimmed override support', () => {
    expect(resolveGlobalRecordingLockDir('artifacts', '  ./locks  ')).toBe(
      './locks',
    )
    expect(resolveGlobalRecordingLockDir('artifacts', undefined)).toBe(
      path.join('artifacts', '.wdio-video-global-slots'),
    )
  })

  it('extracts only valid positive integer pids from slot metadata', () => {
    expect(extractPidFromSlotFile('')).toBeUndefined()
    expect(extractPidFromSlotFile('not-json')).toBeUndefined()
    expect(extractPidFromSlotFile(JSON.stringify({ pid: '123' }))).toBeUndefined()
    expect(extractPidFromSlotFile(JSON.stringify({ pid: 0 }))).toBeUndefined()
    expect(extractPidFromSlotFile(JSON.stringify({ pid: 12.5 }))).toBeUndefined()
    expect(extractPidFromSlotFile(JSON.stringify({ pid: 123 }))).toBe(123)
  })

  it('treats ESRCH as dead and other process.kill errors as alive', () => {
    const killSpy = vi.spyOn(process, 'kill')

    killSpy.mockImplementationOnce(() => true)
    expect(isProcessAlive(123)).toBe(true)

    killSpy.mockImplementationOnce(() => {
      throw Object.assign(new Error('missing'), {
        code: 'ESRCH',
      }) as NodeJS.ErrnoException
    })
    expect(isProcessAlive(456)).toBe(false)

    killSpy.mockImplementationOnce(() => {
      throw Object.assign(new Error('denied'), {
        code: 'EPERM',
      }) as NodeJS.ErrnoException
    })
    expect(isProcessAlive(789)).toBe(true)
  })
})
