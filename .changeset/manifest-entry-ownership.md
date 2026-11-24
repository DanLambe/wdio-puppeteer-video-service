---
'wdio-puppeteer-video-service': patch
---

Each test's manifest entry now describes that test's own recording when hooks overlap or a recording ends early.

- **A completion hook that times out.** When a framework timed out `afterTest` or `afterScenario` while a recording was still being encoded and started the next test, the next test's entry took the earlier test's result and video. The earlier test's entry stayed marked as interrupted with no video. Every manifest step now runs in recording order, so each entry keeps its own result and video.
- **A session that reloads mid-test, or a worker that ends mid-test.** `browser.reloadSession()` or the worker ending kept the recording's video on disk, but its entry stayed marked as interrupted with no video, so the HTML report showed no video. The entry now lists the kept video, and a result that arrives after a reload is added to it.
