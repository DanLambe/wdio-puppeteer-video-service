import { heldContext } from '../utils/held-context.js'

const pauseForRecording = async (ms = 1200) => {
  await browser.pause(ms)
}

// WebDriver BiDi: tests hold the browsing contexts they act on. Frames are
// reached through their tab, and a new window is used without switching to it.
describe('Video Recording Service E2E Verification - Frames (BiDi)', () => {
  it('should handle iframe switching', async () => {
    const page = await browser.url('/nested_frames')

    const topFrame = await page.frame('[name="frame-top"]')
    await pauseForRecording()

    const middleFrame = await topFrame.frame('[name="frame-middle"]')
    await expect(middleFrame.$('#content')).toHaveText('MIDDLE')

    const bottomFrame = await page.frame('[name="frame-bottom"]')
    await expect(bottomFrame.$('body')).toHaveText(
      expect.stringContaining('BOTTOM'),
    )
    await pauseForRecording()
  })

  it('should handle a cross-origin iframe', async () => {
    const page = await browser.url('/cross-origin-iframe')

    const crossOriginFrame = await page.frame('#cross-origin-frame')
    await expect(crossOriginFrame.$('#cross-origin-content')).toHaveText(
      'Cross-origin fixture content',
    )

    // U-02: the next segment starts in a new tab while a frame is held.
    const tab = heldContext(
      await browser.newWindow(new URL('/static', await page.getUrl()).href),
    )
    await expect(await tab.getTitle()).toBe('Static Video Fixture')
    await pauseForRecording()
    await tab.closeWindow()
    await expect(page.$('h1')).toHaveText('Cross-origin Iframe Fixture')
    await pauseForRecording()
  })
})
