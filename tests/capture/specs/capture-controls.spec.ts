import { expect } from '@wdio/globals'

const mode = process.env.WDIO_CAPTURE_MODE ?? 'bidi'

describe('Puppeteer capture protocol and media controls', () => {
  it('records a primed static page without leaking capture viewport state', async () => {
    await browser.url('/static')
    await expect(browser).toHaveTitle('Static Video Fixture')
    await expect($('#static-copy')).toHaveText(
      'This page is intentionally static.',
    )

    if (mode === 'bidi') {
      expect(typeof browser.capabilities.webSocketUrl).toBe('string')
    }
    if (mode === 'classic') {
      expect(typeof browser.capabilities.webSocketUrl).not.toBe('string')
    }
    if (mode === 'hidpi') {
      const dpr = await browser.execute(() =>
        Reflect.get(globalThis, 'devicePixelRatio'),
      )
      expect(dpr).toBe(2)
    }
    if (mode === 'edge') {
      expect(browser.capabilities.browserName?.toLowerCase()).toContain('edge')
    }
    if (mode === 'controls') {
      const viewport = await browser.execute(() => ({
        height: (globalThis as typeof globalThis & { innerHeight: number })
          .innerHeight,
        width: (globalThis as typeof globalThis & { innerWidth: number })
          .innerWidth,
      }))
      expect(viewport).not.toEqual({ width: 960, height: 600 })
    }

    const recordingStartedAt = Number(await browser.execute(() => Date.now()))
    await browser.waitUntil(
      async () => {
        const elapsed = Number(
          await browser.execute(
            (startedAt) => Date.now() - startedAt,
            recordingStartedAt,
          ),
        )
        return elapsed >= 1500
      },
      {
        interval: 100,
        timeout: 3000,
        timeoutMsg: 'static capture did not remain active for 1.5 seconds',
      },
    )
  })
})
