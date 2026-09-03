import fs from 'node:fs/promises'
import path from 'node:path'
import { Given, Then } from '@wdio/cucumber-framework'

const retryMarkerPath = path.resolve(
  process.env.WDIO_RESULTS_DIR ||
    path.join('tests', 'results', 'cucumber-retry-all'),
  '.cucumber-retry-marker',
)

Given('I open the static video fixture', async () => {
  await browser.url('/static')
  await expect(browser).toHaveTitle('Static Video Fixture')
})

Then('I fail only the first scenario attempt', async () => {
  await browser.pause(1200)

  const markerExists = await fs
    .access(retryMarkerPath)
    .then(() => true)
    .catch(() => false)
  if (markerExists) {
    return
  }

  await fs.mkdir(path.dirname(retryMarkerPath), { recursive: true })
  await fs.writeFile(retryMarkerPath, 'first-scenario-attempt', 'utf8')
  throw new Error(
    'Intentional first-attempt failure to verify Cucumber retry recording',
  )
})
