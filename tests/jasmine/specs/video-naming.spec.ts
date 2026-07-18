describe('Jasmine Video Naming', () => {
  it('jasmine style should keep test name in video filename', async () => {
    await browser.url('/static')
    await expect(browser).toHaveTitle('Static Video Fixture')
    await browser.pause(1200)
  })
})
