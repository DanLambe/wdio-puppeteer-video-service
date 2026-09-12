---
"wdio-puppeteer-video-service": patch
---

Request a bounded compositor paint during frame priming so static tabs have an
opportunity to emit more than the initial screencast frame. The unclipped,
low-quality viewport snapshot is discarded in memory, not used to encode video.
Restore the original viewport even if warmup is interrupted and clear the paint
deadline. The public configuration and frame-priming default are unchanged.
