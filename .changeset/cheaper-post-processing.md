---
'wdio-puppeteer-video-service': patch
---

The service looks for FFmpeg before a worker's first test, while the browser warms up, instead of inside the first test, and runs `ffmpeg -version` once for each candidate instead of twice. On Windows each run takes about 34 ms. A missing FFmpeg is still reported once, and recording is still disabled for that worker.
