---
'wdio-puppeteer-video-service': patch
---

A mid-test `browser.reloadSession()` now keeps what a spec-scoped recording captured, and no longer resets retry counting.

- **`recording.scope: 'spec'`.** With `retain: 'failures'`, a reload decided the spec's recording as if the spec had passed, before the test in progress had a result, so the video was deleted even when that test then failed. The recording up to the reload is now kept and listed, as for a test-scoped one. The spec's later tests start a new recording that is kept or discarded by their own results.
- **Cucumber retries.** Cucumber reports no attempt number, so the service counts each scenario's runs, and a reload reset that count. A scenario that reloaded and then failed was retried as if it were its first attempt: `recording.attempts: 'retries'` skipped recording it, and `retain: 'retries'` discarded it. The count now survives a reload.
