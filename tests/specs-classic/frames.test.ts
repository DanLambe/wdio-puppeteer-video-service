const pauseForRecording = async (ms = 1200) => {
  await browser.pause(ms)
}

// WebDriver Classic: frames and windows are selected with switch commands.
describe('Video Recording Service E2E Verification - Frames (Classic)', () => {
  it('should handle iframe switching', async () => {
    await browser.url('/nested_frames')

    const topFrame = await $('[name="frame-top"]').getElement()
    await browser.switchFrame(topFrame)
    await pauseForRecording()

    const middleFrame = await $('[name="frame-middle"]').getElement()
    await browser.switchFrame(middleFrame)
    const content = await $('#content').getElement()
    await expect(content).toHaveText('MIDDLE')

    await browser.switchFrame(null)
    const bottomFrame = await $('[name="frame-bottom"]').getElement()
    await browser.switchFrame(bottomFrame)
    const body = await $('body').getElement()
    await expect(body).toHaveText(expect.stringContaining('BOTTOM'))

    await browser.switchFrame(null)
    await pauseForRecording()
  })

  it('should handle a cross-origin iframe', async () => {
    await browser.url('/cross-origin-iframe')
    const originalHandle = await browser.getWindowHandle()

    const crossOriginFrame = await $('#cross-origin-frame').getElement()
    await browser.switchFrame(crossOriginFrame)
    await expect($('#cross-origin-content')).toHaveText(
      'Cross-origin fixture content',
    )

    // U-02: start the next recording segment directly from an iframe context.
    await browser.newWindow(new URL('/static', await browser.getUrl()).href)
    await expect(browser).toHaveTitle('Static Video Fixture')
    await pauseForRecording()
    await browser.closeWindow()
    await browser.switchToWindow(originalHandle)
    await expect($('h1')).toHaveText('Cross-origin Iframe Fixture')
    await pauseForRecording()
  })
})
