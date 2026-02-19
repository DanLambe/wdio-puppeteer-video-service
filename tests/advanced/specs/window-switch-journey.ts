export const runWindowSwitchingJourney = async (): Promise<void> => {
  await browser.url('https://the-internet.herokuapp.com/windows')
  const link = await $('=Click Here')
  await link.click()

  await browser.waitUntil(
    async () => (await browser.getWindowHandles()).length === 2,
    {
      timeout: 10000,
      timeoutMsg: 'Expected second window to open',
    },
  )

  const handles = await browser.getWindowHandles()
  await browser.switchToWindow(handles[1])
  await expect($('h3')).toHaveText('New Window')
  await browser.pause(900)

  await browser.closeWindow()
  await browser.switchToWindow(handles[0])
  await expect($('h3')).toHaveText('Opening a new window')
  await browser.pause(900)
}
