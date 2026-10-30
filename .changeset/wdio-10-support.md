---
'wdio-puppeteer-video-service': major
---

Support WebdriverIO 10. 2.0 requires WebdriverIO `>=10.1.0 <11` and Puppeteer Core `>=25.0.2 <26`; projects on WebdriverIO 9 keep using 1.x from the `wdio9` npm tag. The options are unchanged. See the [migration guide](https://github.com/DanLambe/wdio-puppeteer-video-service/blob/master/MIGRATION.md#migrating-from-1x-to-20).

- In WebDriver BiDi sessions, recording follows the tab the test drives: a command on a held browsing context from `browser.url()`, `browser.newWindow()` or `browser.browsingContexts()`, a `switchToWindow`, or an element-free action such as `browser.keys()` on WebdriverIO's current window. Recording moves before the command runs, and the recorded tab is brought to the front. Sessions that enforce classic WebDriver keep 1.x behavior.
- A tab the test drives but the service cannot record leaves the recording `failed` with reason `capture-incomplete`; no other tab is filmed in its place.
- Manifest v1 segments now record which tab they filmed (`tab`), and merged and final files list their tabs (`tabs`). The HTML report labels multi-tab videos. Manifests still validate with 1.x.
- Workers on non-Chromium browsers or multiremote sessions no longer start the service, so they write no manifest entries; 1.x wrote a `skipped` entry for each test.
- WebdriverIO's `parallelMode` is not recorded: the service warns once and lists each test as `skipped` with the reason.
