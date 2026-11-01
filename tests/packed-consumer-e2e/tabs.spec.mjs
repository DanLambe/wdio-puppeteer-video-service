import { browser, expect } from '@wdio/globals'

// Tab following leans on WebdriverIO internals, so the installed package is
// checked against the resolved peers: red tab A, held blue tab B, then an
// element-free Classic action, which WebdriverIO sends to its current tab, A.
const colorUrl = (color) =>
  new URL(`/color/${color}`, process.env.CONSUMER_TABS_BASE_URL).href

describe('Installed consumer tabs', () => {
  it('follows a held tab and returns for an implicit action', async () => {
    const page = await browser.url(colorUrl('red'))
    await browser.pause(1_200)

    const tab = await browser.newWindow(colorUrl('blue'), { type: 'tab' })
    await tab.$('#act').click()
    await browser.pause(1_200)

    await browser.keys('x')
    await browser.pause(1_200)
    await expect(page.$('#keys')).toHaveText('x')
  })
})
