describe('Advanced E2E - Spec Filter Recording', () => {
  it('should execute when spec filter mode is configured', async () => {
    await browser.url('/static')
    await expect(browser).toHaveTitle('Static Video Fixture')
    await browser.pause(1000)
  })
})
