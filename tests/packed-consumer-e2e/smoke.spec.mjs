import { browser, expect } from '@wdio/globals'

describe('Installed consumer', () => {
  it('retains playable video with reporter and Allure', async () => {
    await browser.url('/static')
    await expect(browser.$('#label')).toHaveText('Ready')
    // Deliberate capture duration for decoded-media assertions.
    await browser.pause(1_500)
    await expect(browser.$('#label')).toBeDisplayed()
  })
})
