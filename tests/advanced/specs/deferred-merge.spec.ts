import { runWindowSwitchingJourney } from './window-switch-journey.js'

describe('Advanced E2E - Deferred Merge', () => {
  it('should produce a deferred merged artifact for a multi-window flow', async () => {
    await runWindowSwitchingJourney()
  })
})
