import { runWindowSwitchingJourney } from './window-switch-journey.js'

describe('Advanced E2E - No Window Segmentation', () => {
  it('should keep one segment when window switching segmentation is disabled', async () => {
    await runWindowSwitchingJourney()
  })
})
