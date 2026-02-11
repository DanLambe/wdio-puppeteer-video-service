import { Given, Then } from '@wdio/cucumber-framework'

Given('I open the internet home page', async () => {
  await browser.url('https://the-internet.herokuapp.com/')
})

Then('I should see the internet home page title', async () => {
  await expect(browser).toHaveTitle('The Internet')
})

Then('I wait briefly for recording stability', async () => {
  await browser.pause(1200)
})
