import { expect } from '@wdio/globals'
import { startScreencast } from '../../../src/service/capture.js'
import { resolveServiceConfiguration } from '../../../src/service/options.js'

const mode = process.env.WDIO_CAPTURE_MODE ?? 'bidi'

/**
 * Pins the crop-bound contract in a real browser. The capture layer recognizes
 * the recorder's crop errors by their message prefix, so a reworded error would
 * silently drop the diagnostic. The recorder rejects an out-of-bounds crop
 * before it starts FFmpeg or a screencast, so this never disturbs the capture
 * already in progress.
 */
const assertCropDiagnosticIsRecognized = async (): Promise<void> => {
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

    if (mode === 'animation') {
      // A box that moves on every animation frame, so each captured frame differs.
      await browser.execute(`
        const box = document.createElement('div')
        box.style.cssText = 'position:fixed;top:40px;left:0;width:120px;height:120px;background:#2563eb'
        document.body.append(box)
        const startedAt = performance.now()
        const step = (now) => {
          box.style.transform = 'translateX(' + (((now - startedAt) / 4) % 600) + 'px)'
          requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      `)
    }
    if (mode === 'sustained') {
      // A full-HD page whose table and moving box change continuously, like a
      // busy application under test.
      await browser.execute(`
        const rows = Array.from({ length: 40 }, (_, i) => '<tr><td>Year ' + (i + 1) + '</td><td class="v">0</td><td>4.00%</td></tr>').join('')
        const panel = document.createElement('div')
        panel.innerHTML = '<table border="1" style="font:14px Arial;width:100%">' + rows + '</table>'
        document.body.append(panel)
        const box = document.createElement('div')
        box.style.cssText = 'position:fixed;top:300px;left:0;width:160px;height:160px;background:#2563eb'
        document.body.append(box)
        setInterval(() => {
          for (const cell of document.querySelectorAll('.v')) cell.textContent = (Math.random() * 100000).toFixed(2)
        }, 500)
        const step = (now) => {
          box.style.transform = 'translateX(' + ((now / 3) % 1500) + 'px)'
          requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      `)
    }
    const dwellMs = { animation: 3000, sustained: 15_000 }[mode] ?? 1500
    const recordingStartedAt = Number(await browser.execute(() => Date.now()))
    await browser.waitUntil(
      async () => {
        const elapsed = Number(
          await browser.execute(
            (startedAt) => Date.now() - startedAt,
            recordingStartedAt,
          ),
        )
        return elapsed >= dwellMs
      },
      {
        interval: 100,
        timeout: dwellMs + 5000,
        timeoutMsg: `capture did not remain active for ${dwellMs.toString()} ms`,
      },
    )

    await assertCropDiagnosticIsRecognized()
  })
})
