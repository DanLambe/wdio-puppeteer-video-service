import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { remote } from 'webdriverio'

interface ReportBrowserState {
  __wdioReportViolations: string[]
  addEventListener(
    type: string,
    listener: (event: {
      violatedDirective: string
      blockedURI: string
    }) => void,
  ): void
}

export const assertOfflineReportInBrowser = async (
  resultsDir: string,
): Promise<void> => {
  const browser = await remote({
    logLevel: 'error',
    capabilities: {
      browserName: 'chrome',
      'wdio:enforceWebDriverClassic': true,
      'goog:chromeOptions': {
        args: ['--headless=new', '--disable-gpu', '--disable-dev-shm-usage'],
      },
    },
  })
  try {
    const puppeteer = await browser.getPuppeteer()
    const [page] = await puppeteer.pages()
    assert.ok(page, 'Expected a page in the isolated report browser')
    const networkRequests: string[] = []
    page.on('request', (request) => {
      if (/^https?:/u.test(request.url())) {
        networkRequests.push(request.url())
      }
    })
    await page.setOfflineMode(true)
    await page.evaluateOnNewDocument(() => {
      const state = globalThis as unknown as ReportBrowserState
      state.__wdioReportViolations = []
      state.addEventListener('securitypolicyviolation', (event) => {
        state.__wdioReportViolations.push(
          `${event.violatedDirective}: ${event.blockedURI}`,
        )
      })
    })
    await browser.url(
      pathToFileURL(path.join(resultsDir, 'video-report.html')).href,
    )
    assert.equal(await browser.getTitle(), 'WebdriverIO Video Report')
    const cards = () => browser.$$('.result-card:not([hidden])')
    assert.equal(await cards().length, 2, 'Expected both retry outcomes')
    await browser.$('#status-filter').selectByAttribute('value', 'passed')
    await browser.waitUntil(async () => (await cards().length) === 1)
    assert.equal(await cards()[0]?.getAttribute('data-status'), 'passed')
    await browser.$('#status-filter').selectByAttribute('value', 'all')
    await browser.$('#retry-filter').selectByAttribute('value', 'first attempt')
    await browser.waitUntil(async () => (await cards().length) === 0)
    assert.equal(await browser.$('#empty-filter').isDisplayed(), true)
    await browser.$('#retry-filter').selectByAttribute('value', 'retried')
    await browser.waitUntil(async () => (await cards().length) === 2)
    assert.equal(await cards()[0]?.getAttribute('data-retried'), 'true')

    const video = browser.$('video')
    await browser.waitUntil(
      async () => Number(await video.getProperty('readyState')) >= 1,
      {
        timeout: 10_000,
        timeoutMsg: 'Offline report video metadata did not load',
      },
    )
    assert.ok(Number(await video.getProperty('videoWidth')) > 0)
    assert.ok(Number(await video.getProperty('videoHeight')) > 0)
    assert.match(String(await video.getProperty('currentSrc')), /^file:/u)
    await browser.execute(
      (element) => {
        const player = element as unknown as {
          muted: boolean
          play(): Promise<void>
        }
        player.muted = true
        return player.play()
      },
      await video.getElement(),
    )
    await browser.waitUntil(
      async () => Number(await video.getProperty('currentTime')) > 0,
      {
        timeout: 10_000,
        timeoutMsg: 'Offline report video did not play',
      },
    )
    assert.deepEqual(
      await browser.execute(
        () =>
          (globalThis as unknown as ReportBrowserState).__wdioReportViolations,
      ),
      [],
      'Generated report must not violate its CSP',
    )
    assert.deepEqual(
      networkRequests,
      [],
      'Report must not request network assets',
    )
  } finally {
    await browser.deleteSession()
  }
  console.log(
    '[e2e:report] Verified file-origin filters, CSP, and video playback offline.',
  )
}
