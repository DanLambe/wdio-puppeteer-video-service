describe('Advanced E2E - Spec Level Recording', () => {
  it('should execute first step in spec-level mode', async () => {
    await browser.url('https://the-internet.herokuapp.com/')
    await expect(browser).toHaveTitle('The Internet')
    await browser.pause(1100)
  })

  it('should execute second step in spec-level mode', async () => {
    await browser.url('https://the-internet.herokuapp.com/checkboxes')
    const firstCheckbox = await $(
      '#checkboxes input:nth-of-type(1)',
    ).getElement()
    await firstCheckbox.click()
    await expect(firstCheckbox).toBeSelected()
    await browser.pause(1100)
  })
})
