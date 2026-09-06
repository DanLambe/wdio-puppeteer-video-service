import { Then } from '@wdio/cucumber-framework'

Then('I hold the first same-named scenario', async () => {
  await browser.pause(1200)
})

Then('I hold the second same-named scenario', async () => {
  await browser.pause(1200)
})

Then('I hold outline row {string}', async (row: string) => {
  if (!['one', 'two'].includes(row)) {
    throw new Error(`Unexpected outline row: ${row}`)
  }
  await browser.pause(1200)
})
