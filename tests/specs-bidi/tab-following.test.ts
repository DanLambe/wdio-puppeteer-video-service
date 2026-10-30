import { heldContext } from '../utils/held-context.js'

const pauseForRecording = async (ms = 1200) => {
  await browser.pause(ms)
}

// Each tab paints one solid color, so the runner can decode which tab every
// segment recorded. The tests drive held browsing contexts without switching.
describe('Video Recording Service E2E Verification - Tab Following (BiDi)', () => {
  it('should follow a held new window', async () => {
    // Clicking the red tab turns it green.
    const page = await browser.url('/color/red?then=green')
    await pauseForRecording()

    const tab = heldContext(
      await browser.newWindow(
        new URL('/color/blue', await page.getUrl()).href,
        {
          type: 'tab',
        },
      ),
    )
    await tab.$('#act').click()
    await pauseForRecording()

    await page.$('#act').click()
    await pauseForRecording()
    await tab.closeWindow()
  })

  it('should follow a tab the page opens', async () => {
    const page = await browser.url('/color/red')
    await pauseForRecording()

    await page.$('#open-blank').click()
    const tab = await browser.waitUntil(async () => {
      const contexts = await browser.browsingContexts()
      return contexts.find((context) => context.url.endsWith('/color/green'))
    })
    await tab.$('#act').click()
    await pauseForRecording()

    await tab.closeWindow()
    await page.$('#act').click()
    await pauseForRecording()
  })

  // A documented limitation: recording cannot tell who sent a command, so a
  // command on a held tab moves recording there even when the test is busy
  // elsewhere, as another service's background work would.
  it('should follow a background command on a held tab', async () => {
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
    await page.$('#act').click()
    await pauseForRecording()

    const background = new Promise((resolve) => setTimeout(resolve, 300)).then(
      async () => tab.$('#act').click(),
    )
    // The test drives nothing here; pausing sends no command to a tab.
    await pauseForRecording(1500)
    await background

    await page.$('#act').click()
    await pauseForRecording()
    await tab.closeWindow()
  })

  // A rejected switch leaves WebdriverIO's current context on the closed
  // window, so this stays the file's last test.
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
