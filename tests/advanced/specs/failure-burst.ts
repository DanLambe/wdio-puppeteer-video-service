import { runWindowSwitchingJourney } from './window-switch-journey.js'

/**
 * One failing test that moves tab twice, so its kept recording has three
 * parts. Several workers run one each at once, so their recordings are kept,
 * and processed, together.
 */
export const describeFailureBurst = (worker: string): void => {
  describe(`Advanced E2E - Failure burst ${worker}`, () => {
    it(`should keep every part when worker ${worker} fails with the others`, async () => {
      await runWindowSwitchingJourney()

      await expect($('h3')).toHaveText(
        'This assertion intentionally fails so the workers keep recordings together.',
      )
    })
  })
}
