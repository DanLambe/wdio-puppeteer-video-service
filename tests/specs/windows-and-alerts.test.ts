const pauseForRecording = async (ms = 1200) => {
  await browser.pause(ms)
}

describe('Video Recording Service E2E Verification - Windows', () => {
  it('should handle multiple tabs and closing tabs', async () => {
    await browser.url('/windows')
    const link = await $('=Click Here').getElement()
    await link.click()

    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length === 2,
    )

    const handles = await browser.getWindowHandles()
    const [originalHandle, newHandle] = handles
    if (originalHandle === undefined || newHandle === undefined) {
      throw new Error(`Expected two window handles but found ${handles.length}`)
    }

    await browser.switchToWindow(newHandle)
    await expect($('h3')).toHaveText('New Window')
    await pauseForRecording()

    await browser.closeWindow()
    await browser.switchToWindow(originalHandle)
    await expect($('h3')).toHaveText('Opening a new window')
    await pauseForRecording()
  })

  it('should tolerate a browser target closing itself', async () => {
    await browser.url('/windows')
    const originalHandle = await browser.getWindowHandle()
    await $('#open-self-closing').click()

    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length === 2,
      { timeoutMsg: 'Expected self-closing fixture window to open' },
    )
    const targetHandle = (await browser.getWindowHandles()).find(
      (handle) => handle !== originalHandle,
    )
    if (!targetHandle) {
      throw new Error('Expected a second window handle')
    }

    await browser.switchToWindow(targetHandle)
    await expect($('h3')).toHaveText('Self-closing Window')
    await $('#close-window').click()
    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length === 1,
      { timeoutMsg: 'Expected fixture window target to close itself' },
    )

    await browser.switchToWindow(originalHandle)
    await expect($('h3')).toHaveText('Opening a new window')
    await pauseForRecording()
  })

  it('should handle alert, confirm, and prompt dialogs', async () => {
    await browser.url('/alerts')

    await $('#show-alert').click()
    await expect($('#alert-result')).toHaveText('Alert accepted')

    await $('#show-confirm').click()
    await expect($('#alert-result')).toHaveText('Confirm dismissed')

    await $('#show-prompt').click()
    await expect($('#alert-result')).toHaveText('Prompt: null')
    await pauseForRecording()
  })
})
