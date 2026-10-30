import { heldContext } from '../utils/held-context.js'
import { REJECT_NEXT_CAPTURE_START } from './capture-fault-service.js'

const rejectNextCaptureStart = (url: string): void => {
  const reject: unknown = Reflect.get(globalThis, REJECT_NEXT_CAPTURE_START)
  if (typeof reject !== 'function') {
    throw new Error('Expected the capture fault service to be loaded')
  }
  reject(url)
}

// The runner checks the manifest: a driven tab that could not be recorded
// leaves the recording incomplete, even after recording resumes elsewhere.
describe('Capture fault: a driven tab whose recording cannot start', () => {
  it('should report the gap after recording resumes on another tab', async () => {
    const page = await browser.url('/color/red')
    const tab = heldContext(
      await browser.newWindow(
        new URL('/color/blue?then=green', await page.getUrl()).href,
        { type: 'tab' },
      ),
    )
    await page.$('#act').click()

    rejectNextCaptureStart('/color/blue')
    // One command on the blue tab: its start throws, and the action still runs.
    await tab.execute('document.getElementById("act").click()')
    const pages = await (await browser.getPuppeteer()).pages()
    const blue = pages.find((candidate) =>
      candidate.url().includes('/color/blue'),
    )
    if (!blue) {
      throw new Error('Expected the blue tab to be open')
    }
    await expect(
      await blue.evaluate('getComputedStyle(document.body).backgroundColor'),
    ).toBe('rgb(0, 128, 0)')

    await page.$('#act').click()
    await browser.pause(800)
  })
})
