---
'wdio-puppeteer-video-service': patch
---

With `processing.timing: 'after-worker'`, an incomplete recording now leaves the same files as with `'after-test'`. When one segment of an MP4 recording was incomplete, `after-test` transcoded the recording's complete segments while `after-worker` left them as WebM. They are now transcoded when the worker ends; the incomplete segment stays as it was, and nothing is merged. The same applies to a recording that a session reload or the worker's end stops before its test's result: with `after-worker` and merging on, its segments were never transcoded, and now they are.
