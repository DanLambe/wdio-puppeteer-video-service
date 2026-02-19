let retryAttempt = 0

describe('Advanced E2E - Retry Recording', function () {
  this.retries(1)

  it('should record only when retry attempt executes', async () => {
    retryAttempt += 1

    await browser.url('https://the-internet.herokuapp.com/')
    await expect(browser).toHaveTitle('The Internet')
    await browser.pause(1200)

    if (retryAttempt === 1) {
      throw new Error(
        'Intentional first-attempt failure to verify retry-only recording',
      )
    }
  })
})
