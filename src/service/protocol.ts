import type { Browser as PuppeteerBrowser } from 'puppeteer-core'
import { type ClockBoundary, systemClock } from './boundaries.js'

export type SessionProtocol = 'bidi+cdp' | 'classic+cdp' | 'unsupported'

export interface ProtocolBrowser {
  capabilities: WebdriverIO.Capabilities
  getPuppeteer: () => Promise<unknown>
  isBidi?: boolean
  isMultiRemote?: boolean
  options?: {
    hostname?: string
  }
}

export const isChromiumSession = (
  capabilities: WebdriverIO.Capabilities | undefined,
): boolean => {
  const browserName = capabilities?.browserName?.toLowerCase()
  return (
    browserName === 'chrome' ||
    browserName === 'microsoftedge' ||
    browserName === 'edge' ||
    (!!capabilities && 'goog:chromeOptions' in capabilities) ||
    (!!capabilities && 'ms:edgeOptions' in capabilities)
  )
}

/**
 * WDIO reports the session type as `browser.isBidi`. A string `webSocketUrl`
 * capability stands in only when that flag is unavailable.
 */
// Multiremote capabilities name each browser and nest its capabilities.
const isMultiRemoteCapabilities = (capabilities: unknown): boolean => {
  if (!capabilities || typeof capabilities !== 'object') {
    return false
  }
  const entries = Object.entries(capabilities)
  return (
    entries.length > 0 &&
    !('browserName' in capabilities) &&
    entries.every(
      ([, value]) =>
        !!value && typeof value === 'object' && 'capabilities' in value,
    )
  )
}

/**
 * Why a worker's requested capabilities can never be recorded, decided before
 * WDIO constructs the worker service.
 */
export const describeUnsupportedWorker = (
  capabilities: unknown,
): string | undefined => {
  if (isMultiRemoteCapabilities(capabilities)) {
    return 'multiremote sessions are not supported; configure recording for a single-browser WDIO worker'
  }
  if (
    !capabilities ||
    typeof capabilities !== 'object' ||
    !isChromiumSession(capabilities as WebdriverIO.Capabilities)
  ) {
    return 'video recording is only supported on Chromium-based browsers'
  }
  return undefined
}

export const classifySessionProtocol = (
  capabilities: WebdriverIO.Capabilities,
  hasCdpConnection: boolean,
  isBidi?: boolean,
): SessionProtocol => {
  if (!hasCdpConnection || !isChromiumSession(capabilities)) {
    return 'unsupported'
  }
  const bidi = isBidi ?? typeof capabilities.webSocketUrl === 'string'
  return bidi ? 'bidi+cdp' : 'classic+cdp'
}

export const connectPuppeteerWithTimeout = async (
  browser: ProtocolBrowser,
  timeoutMs: number,
  clock: ClockBoundary = systemClock,
): Promise<PuppeteerBrowser> => {
  let timeout: NodeJS.Timeout | undefined
  const timeoutTask = new Promise<never>((_resolve, reject) => {
    timeout = clock.setTimeout(() => {
      reject(
        new Error(
          `Puppeteer CDP connection timed out after ${timeoutMs.toString()}ms`,
        ),
      )
    }, timeoutMs)
    timeout.unref?.()
  })

  try {
    return (await Promise.race([
      browser.getPuppeteer(),
      timeoutTask,
    ])) as PuppeteerBrowser
  } finally {
    if (timeout) {
      clock.clearTimeout(timeout)
    }
  }
}

export const describePuppeteerConnectionFailure = (
  browser: Pick<ProtocolBrowser, 'capabilities' | 'isMultiRemote' | 'options'>,
  error: unknown,
): string => {
  const details = describeError(error)
  if (browser.isMultiRemote) {
    return 'multiremote sessions are not supported; configure recording for a single-browser WDIO worker'
  }

  if (/browser runner|component runner/iu.test(details)) {
    return 'WDIO browser/component runner sessions do not expose the CDP connection required by Puppeteer screencast; use the WDIO local runner'
  }

  if (!isChromiumSession(browser.capabilities)) {
    return 'only local Chrome and Chromium Edge sessions with a CDP endpoint are supported'
  }

  if (
    usesRemoteDebuggingPipe(browser.capabilities) ||
    /--remote-debugging-pipe/iu.test(details)
  ) {
    return 'the session uses --remote-debugging-pipe, which WDIO getPuppeteer cannot attach to; remove that argument so Chrome exposes a debugger address'
  }

  const hostname = browser.options?.hostname?.toLowerCase()
  if (hostname && !isLocalHostname(hostname)) {
    return `remote/cloud endpoint ${hostname} did not expose a usable se:cdp WebSocket URL; configure the provider to expose CDP (${details})`
  }

  return `the session did not expose a usable CDP endpoint; WDIO may control through WebDriver BiDi, but Puppeteer video capture still requires CDP (${details})`
}

const usesRemoteDebuggingPipe = (
  capabilities: WebdriverIO.Capabilities | undefined,
): boolean => {
  const options = readChromiumOptions(capabilities)
  return options.args?.includes('--remote-debugging-pipe') ?? false
}

const readChromiumOptions = (
  capabilities: WebdriverIO.Capabilities | undefined,
): { args?: string[] } => {
  if (!capabilities) {
    return {}
  }
  const value =
    capabilities['goog:chromeOptions'] ?? capabilities['ms:edgeOptions']
  if (!value || typeof value !== 'object') {
    return {}
  }
  const args = Reflect.get(value, 'args')
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) {
    return {}
  }
  return { args }
}

const isLocalHostname = (hostname: string): boolean => {
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  )
}

const describeError = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}
