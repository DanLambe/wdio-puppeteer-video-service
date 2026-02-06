const pauseForRecording = async (ms = 1200) => {
  await browser.pause(ms)
}

describe('Video Recording Service E2E Verification - Long Journey', () => {
  it('should handle viewport resizing', async () => {
    await browser.url('https://the-internet.herokuapp.com/')
    await browser.setWindowSize(500, 600)
    await pauseForRecording(900)
    await browser.setWindowSize(1200, 800)
    await pauseForRecording(900)
  })

  it('should record a longer multi-step journey', async () => {
    await browser.url('https://the-internet.herokuapp.com/')
    await expect(browser).toHaveTitle('The Internet')
    await pauseForRecording(1500)

    const dynamicLoadingLink = await $('=Dynamic Loading')
    await dynamicLoadingLink.scrollIntoView()
    await dynamicLoadingLink.click()
    await pauseForRecording()

    const exampleOneLink = await $('=Example 1: Element on page that is hidden')
    await exampleOneLink.click()
    await pauseForRecording()

    const startButton = await $('#start button')
    await startButton.click()
    const finishMessage = await $('#finish')
    await finishMessage.waitForExist({ timeout: 15_000 })
    await expect(finishMessage).toHaveText(
      expect.stringContaining('Hello World!'),
    )
    await pauseForRecording(2000)

    await browser.back()
    await pauseForRecording(1000)
    await browser.back()
    await pauseForRecording(1000)

    const checkboxesLink = await $('=Checkboxes')
    await checkboxesLink.click()
    const secondCheckbox = await $('#checkboxes input:nth-of-type(2)')
    await secondCheckbox.click()
    await expect(secondCheckbox).not.toBeSelected()
    await pauseForRecording(1800)
  })
})
