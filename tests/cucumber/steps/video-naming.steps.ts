import { Given, Then } from '@wdio/cucumber-framework'

Given('I open the internet home page', async () => {
  await browser.url('/')
})

Then('I should see the internet home page title', async () => {
  await expect(browser).toHaveTitle('Video Fixture Lab')
})

Then('I wait briefly for recording stability', async () => {
  await browser.pause(1200)
})
