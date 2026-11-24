---
'wdio-puppeteer-video-service': patch
---

`browser.reloadSession()` in the middle of a test no longer adds a short extra segment to that test's recording. WebdriverIO sets the new session up with commands of its own before the service hears of the reload, and those commands moved recording to the new session's tab, which was filmed for a moment as the test's next part. Commands sent after the old session is deleted and before the reload completes no longer move recording.
