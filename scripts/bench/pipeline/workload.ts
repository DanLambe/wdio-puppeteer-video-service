import { browser, expect } from '@wdio/globals'

export const workload = (index: number) => {
  describe(`Pipeline worker ${index}`, () => {
    for (const fixture of process.env.PIPELINE_SOAK === '1'
      ? ['animated']
      : ['static', 'animated']) {
      it(`records ${fixture}`, async () => {
        await browser.url(`/${fixture}`)
        await expect(browser.$('#label')).toHaveText('Ready')
        // This dwell is the measured capture workload, not synchronization.
        await browser.pause(Number(process.env.PIPELINE_DWELL_MS))
        await expect(browser.$('#label')).toBeDisplayed()
      })
    }
  })
}
