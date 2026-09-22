---
'wdio-puppeteer-video-service': patch
---

Decode screencast frames only when they are written to the encoder. Chrome
delivers frames faster than `capture.fps` on a busy page, and a frame
superseded before the timeline advanced was still being turned into a buffer
that nothing consumed.
