export interface WindowSwitchingJourneyOptions {
  /** Runs once the test drives another tab, with how many segments stopped. */
  readonly afterTabMove?: (stoppedSegments: number) => Promise<void>
}

export const runWindowSwitchingJourney = async (
  options: WindowSwitchingJourneyOptions = {},
): Promise<void> => {
  await browser.url('/windows')
  const link = await $('=Click Here').getElement()
  await link.click()

  await browser.waitUntil(
    async () => (await browser.getWindowHandles()).length === 2,
    {
      timeout: 10000,
      timeoutMsg: 'Expected second window to open',
    },
  )

  const handles = await browser.getWindowHandles()
  const [originalHandle, newHandle] = handles
  if (originalHandle === undefined || newHandle === undefined) {
    throw new Error(`Expected two window handles but found ${handles.length}`)
  }

  await browser.switchToWindow(newHandle)
  await expect($('h3')).toHaveText('New Window')
  await options.afterTabMove?.(1)
  await browser.pause(900)

  await browser.closeWindow()
  await browser.switchToWindow(originalHandle)
  await expect($('h3')).toHaveText('Opening a new window')
  await options.afterTabMove?.(2)
  await browser.pause(900)
}
