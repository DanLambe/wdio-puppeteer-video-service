---
'wdio-puppeteer-video-service': patch
---

Prevent optional retained-video metadata probe failures from disabling FFmpeg
for later recordings, transcodes, and merges. Keep existing essential-processing
failure behavior unchanged and warn once per session when metadata is skipped
because the FFmpeg runtime is unavailable. Clarify metadata capacity waits and
the optional dimension-field contract.
