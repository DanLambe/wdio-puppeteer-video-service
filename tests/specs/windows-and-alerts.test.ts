const pauseForRecording = async (ms = 1200) => {
  await browser.pause(ms)
}

describe('Video Recording Service E2E Verification - Windows And Alerts', () => {
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

  it('should handle javascript alerts', async () => {
    await browser.url('https://the-internet.herokuapp.com/javascript_alerts')
    const button = await $('button=Click for JS Alert').getElement()
    await button.click()
    await browser.acceptAlert()
    await expect($('#result')).toHaveText('You successfully clicked an alert')
    await pauseForRecording()
  })
})
