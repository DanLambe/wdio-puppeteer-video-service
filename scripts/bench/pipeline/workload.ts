import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { browser, expect } from '@wdio/globals'
import { SWITCH_CROSSINGS, type SwitchTimings } from './statistics.js'

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

/**
 * Drives two held WebDriver BiDi tabs in turn, timing a click after each
 * crossing and then a read on that tab. Each tab draws its identity and click
 * count, so the media check can tell whether a segment opened before its first
 * action. The same-tab command stays a read, so it measures tab following
 * rather than the cost of filming a repaint. Opening the second tab moves
 * recording to it, so a recorded test has two segments more than its
 * crossings.
 */
export const switchingWorkload = (index: number) => {
  describe(`Pipeline switching worker ${index}`, () => {
    it('switches between held tabs', async () => {
      const dwellMs = Number(process.env.PIPELINE_DWELL_MS)
      const page = await browser.url('/static?tab=1')
      await expect(page.$('#label')).toHaveText('Ready')
      await browser.pause(dwellMs)
      const opened = await browser.newWindow(
        `${process.env.PIPELINE_URL}/animated?tab=2`,
        { type: 'tab' },
      )
      if (!('contextId' in opened)) {
        throw new Error('Expected a WebDriver BiDi browsing context')
      }
      await expect(opened.$('#label')).toHaveText('Ready')
      await browser.pause(dwellMs)
      const timings: SwitchTimings = { crossingMs: [], sameTabMs: [] }
      for (let crossing = 0; crossing < SWITCH_CROSSINGS; crossing += 1) {
        const tab = crossing % 2 === 0 ? page : opened
        let start = performance.now()
        await tab.$('#label').click()
        timings.crossingMs.push(performance.now() - start)
        start = performance.now()
        await tab.$('#label').getText()
        timings.sameTabMs.push(performance.now() - start)
        // This dwell is the measured capture workload, not synchronization.
        await browser.pause(dwellMs)
      }
      writeFileSync(
        path.join(
          process.env.PIPELINE_RUN_DIR as string,
          `switch-${index}.json`,
        ),
        JSON.stringify(timings),
      )
    })
  })
}
