describe('Advanced E2E - Filename Style', () => {
  it('unique title token should not appear for session style modes', async () => {
    await browser.url('/static')
    await expect(browser).toHaveTitle('Static Video Fixture')
    await browser.pause(1200)
  })
})
