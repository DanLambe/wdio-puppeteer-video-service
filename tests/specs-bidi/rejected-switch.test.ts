import { heldContext } from '../utils/held-context.js'

const pauseForRecording = async (ms = 1200) => {
  await browser.pause(ms)
}

// A rejected switch leaves WebdriverIO's current context on the closed window,
// so this test has a spec file, and a browser session, of its own.
describe('Video Recording Service E2E Verification - Rejected Switch (BiDi)', () => {
  it('should return to its window when a switch to a closed one is rejected', async () => {
    const page = await browser.url('/color/red')
    await pauseForRecording()

    const tab = heldContext(
      await browser.newWindow(
        new URL('/color/blue', await page.getUrl()).href,
        { type: 'tab' },
      ),
    )
    await tab.$('#act').click()
    await pauseForRecording()
    await browser.switchToWindow(page.contextId)
    await pauseForRecording()

    // Close the blue tab outside WDIO, so the recorder still knows its handle.
    const pages = await (await browser.getPuppeteer()).pages()
    const blue = pages.find((candidate) =>
      candidate.url().endsWith('/color/blue'),
    )
    if (!blue) {
      throw new Error('Expected the blue tab to be open')
    }
    await blue.close()
    let rejected = false
    try {
      await browser.switchToWindow(tab.contextId)
    } catch {
      rejected = true
    }
    await browser.keys('x')
    await pauseForRecording()

    expect(rejected).toBe(true)
    await expect(page.$('#keys')).toHaveText('x')
  })
})
