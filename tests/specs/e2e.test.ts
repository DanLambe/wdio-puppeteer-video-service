const pauseForRecording = async (ms = 1200) => {
  await browser.pause(ms)
}

describe('Video Recording Service E2E Verification - Core Navigation', () => {
  it('should record a simple navigation', async () => {
    await browser.url('/')
    await expect(browser).toHaveTitle('Video Fixture Lab')
    await $('=Static Page').click()
    await expect(browser).toHaveTitle('Static Video Fixture')
    await expect($('#static-copy')).toHaveText(
      'This page is intentionally static.',
    )
    await pauseForRecording()
  })

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

    const crossOriginFrame = await $('#cross-origin-frame').getElement()
    await browser.switchFrame(crossOriginFrame)
    await expect($('#cross-origin-content')).toHaveText(
      'Cross-origin fixture content',
    )

    await browser.switchFrame(null)
    await expect($('h1')).toHaveText('Cross-origin Iframe Fixture')
    await pauseForRecording()
  })
})
