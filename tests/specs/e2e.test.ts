const pauseForRecording = async (ms = 1200) => {
  await browser.pause(ms)
}

describe('Video Recording Service E2E Verification - Core Navigation', () => {
  it('should record a simple navigation', async () => {
    await browser.url('/')
    await expect(browser).toHaveTitle('Video Fixture Lab')
    await $('=Static Page').click()
    await expect(browser).toHaveTitle('Static Video Fixture')
    await expect($('#static-copy')).toHaveText(
      'This page is intentionally static.',
    )
    await pauseForRecording()
  })
})
