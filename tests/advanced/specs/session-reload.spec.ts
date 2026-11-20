// A session reload in the middle of a test ends its recording: the video up to
// the reload is kept, its manifest entry lists it, and the result that arrives
// afterwards is added to that entry. The next test records on the new session.
describe('Advanced E2E - Session reload', () => {
  it('should keep the video recorded before a mid-test session reload', async () => {
    await browser.url('/color/red')
    await browser.pause(800)
    await browser.reloadSession()
    await browser.url('/color/blue')
    throw new Error('This test intentionally fails after its session reloads.')
  })

  it('should record the next test on the reloaded session', async () => {
    await browser.url('/color/green')
    await browser.pause(800)
    throw new Error('This test intentionally fails to keep its recording.')
  })
})
