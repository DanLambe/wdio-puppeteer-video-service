import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifySessionProtocol,
  connectPuppeteerWithTimeout,
  describePuppeteerConnectionFailure,
  isChromiumSession,
  type ProtocolBrowser,
} from '../../src/service/protocol.js'

const chromeCapabilities = {
  browserName: 'chrome',
} as WebdriverIO.Capabilities

describe('WDIO and Puppeteer protocol compatibility', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('recognizes Chrome and Chromium Edge sessions', () => {
    expect(isChromiumSession(chromeCapabilities)).toBe(true)
    expect(isChromiumSession({ browserName: 'MicrosoftEdge' })).toBe(true)
    expect(isChromiumSession({ 'goog:chromeOptions': {} })).toBe(true)
    expect(isChromiumSession({ browserName: 'firefox' })).toBe(false)
    expect(isChromiumSession(undefined)).toBe(false)
  })

  it('classifies BiDi control separately from the required CDP capture path', () => {
    expect(
      classifySessionProtocol(
        {
          ...chromeCapabilities,
          webSocketUrl: 'ws://localhost/bidi',
        } as unknown as WebdriverIO.Capabilities,
        true,
      ),
    ).toBe('bidi+cdp')
    expect(classifySessionProtocol(chromeCapabilities, true)).toBe(
      'classic+cdp',
    )
    expect(classifySessionProtocol(chromeCapabilities, false)).toBe(
      'unsupported',
    )
    expect(classifySessionProtocol({ browserName: 'firefox' }, true)).toBe(
      'unsupported',
    )
  })

  it('returns the WDIO Puppeteer connection before the configured deadline', async () => {
    const puppeteerBrowser = { connected: true }
    const browser = {
      capabilities: chromeCapabilities,
      getPuppeteer: vi.fn(async () => puppeteerBrowser),
    } satisfies ProtocolBrowser

    await expect(connectPuppeteerWithTimeout(browser, 1000)).resolves.toBe(
      puppeteerBrowser,
    )
    expect(browser.getPuppeteer).toHaveBeenCalledOnce()
  })

  it('bounds a Puppeteer connection that never settles', async () => {
    vi.useFakeTimers()
    const connection = connectPuppeteerWithTimeout(
      {
        capabilities: chromeCapabilities,
        getPuppeteer: async () => new Promise<never>(() => {}),
      },
      25,
    )

    const rejection = expect(connection).rejects.toThrow(
      'Puppeteer CDP connection timed out after 25ms',
    )
    await vi.advanceTimersByTimeAsync(25)
    await rejection
  })

  it.each([
    [
      {
        capabilities: chromeCapabilities,
        isMultiremote: true,
      },
      new Error('ignored'),
      'multiremote sessions are not supported',
    ],
    [
      { capabilities: chromeCapabilities },
      new Error('Puppeteer is not supported in browser runner'),
      'browser/component runner sessions do not expose',
    ],
    [
      { capabilities: { browserName: 'firefox' } },
      new Error('unsupported'),
      'only local Chrome and Chromium Edge',
    ],
    [
      {
        capabilities: {
          ...chromeCapabilities,
          'goog:chromeOptions': { args: ['--remote-debugging-pipe'] },
        },
      },
      new Error('pipe unsupported'),
      'remove that argument',
    ],
    [
      { capabilities: chromeCapabilities },
      new Error('Cannot attach when args include --remote-debugging-pipe'),
      'remove that argument',
    ],
    [
      {
        capabilities: chromeCapabilities,
        options: { hostname: 'grid.example.test' },
      },
      new Error('missing se:cdp'),
      'remote/cloud endpoint grid.example.test',
    ],
    [
      { capabilities: chromeCapabilities },
      new Error('missing endpoint'),
      'WDIO may control through WebDriver BiDi',
    ],
  ])(
    'provides an actionable unsupported-session diagnostic %#',
    (browser, error, expected) => {
      expect(describePuppeteerConnectionFailure(browser, error)).toContain(
        expected,
      )
    },
  )
})
