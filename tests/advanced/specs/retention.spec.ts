describe('Advanced E2E - Retention', () => {
  it('should discard a passing recording', async () => {
    await browser.url('/static')
    await expect($('#static-copy')).toHaveText(
      'This page is intentionally static.',
    )
    await browser.pause(900)
  })

  it('should retain an intentionally failed recording', async () => {
    await browser.url('/static')
    await browser.pause(900)

    await expect($('#static-copy')).toHaveText(
      'This assertion intentionally fails to characterize failure retention.',
    )
  })
})
