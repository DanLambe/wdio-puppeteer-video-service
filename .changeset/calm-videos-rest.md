---
"wdio-puppeteer-video-service": patch
---

Skip optional end-of-test transcoding for recordings that the retention policy
will discard, while preserving retained and mid-test window-segment processing.
Also cancel the write-stream completion timer after the stream settles.
