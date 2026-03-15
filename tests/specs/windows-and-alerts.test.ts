const pauseForRecording = async (ms = 1200) => {
  await browser.pause(ms)
}

const alertFixtureUrl = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Alert Fixture</title>
  </head>
  <body>
    <button
      id="alert-button"
      type="button"
      onclick="alert('Video service alert'); document.querySelector('#result').textContent = 'You successfully clicked an alert'"
    >
      Click for JS Alert
    </button>
    <p id="result"></p>
  </body>
</html>`)}`

const waitForAlertToOpen = async () => {
  await browser.waitUntil(
    async () => {
      try {
        await browser.getAlertText()
        return true
      } catch {
        return false
      }
    },
    {
      timeout: 5000,
      timeoutMsg:
        'Expected javascript alert to open after clicking alert button',
    },
  )
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
    await browser.url(alertFixtureUrl)
    const button = await $('#alert-button').getElement()
    await button.click()
    await waitForAlertToOpen()
    await browser.acceptAlert()
    await expect($('#result')).toHaveText('You successfully clicked an alert')
    await pauseForRecording()
  })
})
