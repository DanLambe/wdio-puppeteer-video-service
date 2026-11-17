---
'wdio-puppeteer-video-service': patch
---

A recording now ends on the last change the test made. Before, a change made just before a test ended, or just before recording moved to another tab, was often missing from that video or segment, because Chrome was still capturing its frame when recording stopped. Stopping now waits up to 125 ms for that frame, so each kept stop and each tab move can take up to 125 ms longer; on a page that keeps changing the wait ends with the next frame.
