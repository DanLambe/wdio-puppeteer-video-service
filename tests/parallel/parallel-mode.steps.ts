import { Given, Then } from '@wdio/cucumber-framework'
import { awaitParallelPeers } from './overlap.js'

Given(/^I open the (red|blue) color tab$/u, async (color: string) => {
  await awaitParallelPeers(color)
  await browser.url(`/color/${color}`)
})

Then('the tab title is {string}', async (title: string) => {
  await expect(browser).toHaveTitle(title)
})
