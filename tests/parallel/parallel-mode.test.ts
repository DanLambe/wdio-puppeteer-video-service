import { awaitParallelPeers } from './overlap.js'

// Run with mochaOpts.parallelMode: both tests run at once, each in its own
// browser context.
describe('Video Recording Service E2E Verification - parallelMode (Mocha)', () => {
  it('should run the first parallel test without recording', async () => {
    await awaitParallelPeers('red')
    await browser.url('/color/red')
    await expect(browser).toHaveTitle('red tab')
  })

  it('should run the second parallel test without recording', async () => {
    await awaitParallelPeers('blue')
    await browser.url('/color/blue')
    await expect(browser).toHaveTitle('blue tab')
  })
})
