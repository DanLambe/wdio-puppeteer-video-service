describe('Advanced E2E - Global Concurrency B', () => {
  it('should record global concurrency worker B', async () => {
    await browser.url('/animation')
    await expect($('#animation-status')).toHaveText('Animation complete')
  })
})
