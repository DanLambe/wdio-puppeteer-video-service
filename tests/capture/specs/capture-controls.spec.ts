import { expect } from '@wdio/globals'
import { startScreencast } from '../../../src/service/capture.js'
import { resolveServiceConfiguration } from '../../../src/service/options.js'

const mode = process.env.WDIO_CAPTURE_MODE ?? 'bidi'

/**
 * Pins the upstream crop-bound contract against the installed Puppeteer. The
 * service recognizes Puppeteer's crop errors by their message prefix, so a
 * reworded upstream error would silently drop the diagnostic while the unit
 * test — which uses a copy of that wording — kept passing. Puppeteer rejects an
 * out-of-bounds crop before it constructs a recorder, so this never disturbs
 * the capture already in progress.
 */
const assertCropDiagnosticStillMatchesPuppeteer = async (): Promise<void> => {
  const puppeteer = await browser.getPuppeteer()
  const [page] = await puppeteer.pages()
  if (!page) {
    throw new Error('Expected a Puppeteer page for the crop diagnostic check')
  }
  const capture = resolveServiceConfiguration({
    capture: {
      viewport: 'current',
      crop: { x: 0, y: 0, width: 100_000, height: 100_000 },
    },
  }).options.capture

  const failure = await startScreencast(page, {
    capture,
    format: 'webm',
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || 'ffmpeg',
  }).then(
    () => undefined,
    (error: unknown) => error,
  )

  expect(failure).toBeInstanceOf(Error)
  const diagnostic = failure as Error
  expect(diagnostic.message).toContain('capture.crop')
  expect(diagnostic.message).toContain('capture.viewport')
  expect(diagnostic.cause).toBeInstanceOf(Error)
  expect((diagnostic.cause as Error).message.startsWith('`crop.')).toBe(true)
}

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

    await assertCropDiagnosticStillMatchesPuppeteer()
  })
})
