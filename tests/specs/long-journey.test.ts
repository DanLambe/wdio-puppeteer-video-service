const pauseForRecording = async (ms = 1200) => {
  await browser.pause(ms)
}

describe('Video Recording Service E2E Verification - Long Journey', () => {
  it('should handle viewport resizing', async () => {
    await browser.url('/')
    await browser.setWindowSize(500, 600)
    await pauseForRecording(900)
    await browser.setWindowSize(1200, 800)
    await pauseForRecording(900)
  })

  it('should capture a deterministic animation', async () => {
    await browser.url('/animation')
    await browser.waitUntil(
      async () => {
        return (
          (await $('body').getAttribute('data-animation-state')) === 'complete'
        )
      },
      {
        timeout: 5_000,
        timeoutMsg: 'Expected fixture animation to complete',
      },
    )
    await expect($('#animation-status')).toHaveText('Animation complete')
  })

  it('should record a longer multi-step journey', async () => {
    await browser.url('/')
    await expect(browser).toHaveTitle('Video Fixture Lab')
    await pauseForRecording(1500)

    const dynamicLoadingLink = await $('=Dynamic Loading').getElement()
    await dynamicLoadingLink.scrollIntoView()
    await dynamicLoadingLink.click()
    await pauseForRecording()

    const exampleOneLink = await $(
      '=Example 1: Element on page that is hidden',
    ).getElement()
    await exampleOneLink.click()
    await pauseForRecording()

    const startButton = await $('#start button').getElement()
    await startButton.click()
    const finishMessage = await $('#finish').getElement()
    await finishMessage.waitForExist({ timeout: 15_000 })
    await expect(finishMessage).toHaveText(
      expect.stringContaining('Hello World!'),
    )
    await pauseForRecording(2000)

    await browser.back()
    await pauseForRecording(1000)
    await browser.back()
    await pauseForRecording(1000)

    const checkboxesLink = await $('=Checkboxes').getElement()
    await checkboxesLink.click()
    const secondCheckbox = await $('#checkbox-2').getElement()
    await secondCheckbox.click()
    await expect(secondCheckbox).not.toBeSelected()
    await pauseForRecording(1800)
  })
})
