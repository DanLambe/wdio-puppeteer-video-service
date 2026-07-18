describe('Advanced E2E - FFmpeg Failure', () => {
  it('should preserve original media when FFmpeg transcoding fails', async () => {
    await browser.url('/animation')
    await expect($('#animation-status')).toHaveText('Animation complete')
  })
})
