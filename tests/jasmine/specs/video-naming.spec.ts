describe('Jasmine Video Naming', () => {
  it('jasmine style should keep test name in video filename', async () => {
    await browser.url('https://the-internet.herokuapp.com/')
    await expect(browser).toHaveTitle('The Internet')
    await browser.pause(1200)
  })
})
