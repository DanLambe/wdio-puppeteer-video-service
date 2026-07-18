describe('Advanced E2E - Spec Level Recording', () => {
  it('should execute first step in spec-level mode', async () => {
    await browser.url('/static')
    await expect(browser).toHaveTitle('Static Video Fixture')
    await browser.pause(1100)
  })

  it('should execute second step in spec-level mode', async () => {
    await browser.url('/checkboxes')
    const firstCheckbox = await $('#checkbox-1').getElement()
    await firstCheckbox.click()
    await expect(firstCheckbox).toBeSelected()
    await browser.pause(1100)
  })
})
