describe('Advanced E2E - Global Concurrency A', () => {
  it('should record global concurrency worker A', async () => {
    await browser.url('/animation')
    await expect($('#animation-status')).toHaveText('Animation complete')
  })
})
