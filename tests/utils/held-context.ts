type NewWindowResult = Awaited<ReturnType<WebdriverIO.Browser['newWindow']>>

/** `browser.newWindow()` returns a browsing context in a WebDriver BiDi session. */
export const heldContext = (
  value: NewWindowResult,
): WebdriverIO.BrowsingContext => {
  if (!('contextId' in value)) {
    throw new Error('Expected a WebDriver BiDi session to return a context')
  }
  return value
}
