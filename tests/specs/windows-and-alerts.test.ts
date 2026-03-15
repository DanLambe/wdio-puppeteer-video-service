const pauseForRecording = async (ms = 1200) => {
  await browser.pause(ms)
}

describe('Video Recording Service E2E Verification - Windows', () => {
  it('should handle multiple tabs and closing tabs', async () => {
    await browser.url('https://the-internet.herokuapp.com/windows')
    const link = await $('=Click Here').getElement()
    await link.click()

    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length === 2,
    )

    const handles = await browser.getWindowHandles()
    await browser.switchToWindow(handles[1])
    await expect($('h3')).toHaveText('New Window')
    await pauseForRecording()

    await browser.closeWindow()
    await browser.switchToWindow(handles[0])
    await expect($('h3')).toHaveText('Opening a new window')
    await pauseForRecording()
  })
})
