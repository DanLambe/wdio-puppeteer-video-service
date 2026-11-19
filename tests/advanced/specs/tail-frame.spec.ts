import { heldContext } from '../../utils/held-context.js'

// Each test turns the red tab green and stops its segment straight away. Chrome
// delivers the frame of that paint a little after the click returns, so the
// runner checks that each segment still ends on green.
describe('Advanced E2E - Tail frame', () => {
  it('should film the last paint before a kept test ends', async () => {
    await browser.url('/color/red?then=green')
    await browser.pause(800)
    await $('#act').click()
  })

  it('should film the last paint before recording moves to another tab', async () => {
    const page = await browser.url('/color/red?then=green')
    await browser.pause(800)
    const tab = heldContext(
      await browser.newWindow(
        new URL('/color/blue', await page.getUrl()).href,
        { type: 'tab' },
      ),
    )
    // Part 2: recording follows the command to the blue tab.
    await tab.$('#act').click()
    await browser.pause(800)
    // Part 3: back on the red tab, which the click turns green; the next
    // command moves recording to the blue tab at once (part 4).
    await page.$('#act').click()
    await tab.$('#act').click()
    await browser.pause(800)
    await tab.closeWindow()
  })
})
