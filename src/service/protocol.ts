import type { Browser as PuppeteerBrowser } from 'puppeteer-core'

export type SessionProtocol = 'bidi+cdp' | 'classic+cdp' | 'unsupported'

export interface ProtocolBrowser {
  capabilities: WebdriverIO.Capabilities
  getPuppeteer: () => Promise<unknown>
  isMultiremote?: boolean
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

export const classifySessionProtocol = (
  capabilities: WebdriverIO.Capabilities,
  hasCdpConnection: boolean,
): SessionProtocol => {
  if (!hasCdpConnection || !isChromiumSession(capabilities)) {
    return 'unsupported'
  }
  return typeof capabilities.webSocketUrl === 'string'
    ? 'bidi+cdp'
    : 'classic+cdp'
}

export const connectPuppeteerWithTimeout = async (
  browser: ProtocolBrowser,
  timeoutMs: number,
): Promise<PuppeteerBrowser> => {
  let timeout: NodeJS.Timeout | undefined
  const timeoutTask = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
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
      clearTimeout(timeout)
    }
  }
}

export const describePuppeteerConnectionFailure = (
  browser: Pick<ProtocolBrowser, 'capabilities' | 'isMultiremote' | 'options'>,
  error: unknown,
): string => {
  const details = describeError(error)
  if (browser.isMultiremote) {
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
