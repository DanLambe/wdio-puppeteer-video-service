describe('Advanced E2E - Spec Filter Recording', () => {
  it('should execute when spec filter mode is configured', async () => {
    await browser.url('https://the-internet.herokuapp.com/')
    await expect(browser).toHaveTitle('The Internet')
    await browser.pause(1000)
  })
})
