---
'wdio-puppeteer-video-service': patch
---

In WebDriver BiDi sessions, recording no longer jumps to a newly opened window because of WebdriverIO's own setup script before the test switches to it. A script now moves recording only to a tab the test holds (from `browser.url()`, `browser.newWindow()`, `browser.browsingContexts()` or a context's `frame()`), a window it has switched to, WebdriverIO's current window, or the recorded tab. A raw `browser.scriptCallFunction()` or `browser.scriptEvaluate()` on a tab known only from `browser.getWindowHandles()` no longer moves recording there; switch to the tab first or use a held context. See the [migration guide](https://github.com/DanLambe/wdio-puppeteer-video-service/blob/master/MIGRATION.md#what-changes-in-webdriver-bidi-sessions).

An implicit action after `browser.switchToWindow()`, such as `browser.keys()`, no longer moves recording back to the previous tab when a current-window lookup the service started before the switch answers late. Likewise, such a late answer no longer sends recording to a tab that `browser.browsingContextClose()` has closed.
