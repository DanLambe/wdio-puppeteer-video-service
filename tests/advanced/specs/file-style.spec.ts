describe('Advanced E2E - Filename Style', () => {
  it('unique title token should not appear for session style modes', async () => {
    await browser.url('https://the-internet.herokuapp.com/')
    await expect(browser).toHaveTitle('The Internet')
    await browser.pause(1200)
  })
})
