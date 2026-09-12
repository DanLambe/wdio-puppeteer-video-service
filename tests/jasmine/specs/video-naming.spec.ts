// WDIO exposes mixed framework globals; declare this Jasmine-only runtime API locally.
declare function pending(reason?: string): never

describe('Jasmine Video Naming', () => {
  it('jasmine style should keep test name in video filename', async () => {
    await browser.url('/static')
    await expect(browser).toHaveTitle('Static Video Fixture')
    await browser.pause(1200)
  })

  it('jasmine style should retain an explicitly pending recording', async () => {
    await browser.url('/static')
    await expect(browser).toHaveTitle('Static Video Fixture')
    // Ensure the runtime skip happens after a decodable recording exists.
    await browser.pause(1200)
    pending(
      'Intentional runtime skip for manifest and retained Allure coverage',
    )
  })
})
