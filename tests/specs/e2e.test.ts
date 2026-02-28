const pauseForRecording = async (ms = 1200) => {
  await browser.pause(ms)
}

describe('Video Recording Service E2E Verification - Core Navigation', () => {
  it('should record a simple navigation', async () => {
    await browser.url('https://the-internet.herokuapp.com/')
    await expect(browser).toHaveTitle('The Internet')
    await pauseForRecording()
  })

  it('should handle iframe switching', async () => {
    await browser.url('https://the-internet.herokuapp.com/nested_frames')

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
})
