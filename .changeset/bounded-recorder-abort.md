---
'wdio-puppeteer-video-service': patch
---

Cancel stalled recording shutdown without leaving the encoder running. After
the existing five-second graceful-stop deadline, terminate the recording's
owned FFmpeg process tree and settle pending recorder work. Close the output
file while preserving bytes already written, and mark the segment unclean so
it is not transcoded as a completed capture. This avoids a redundant stream
completion timeout and prevents an abandoned encoder from keeping a worker
alive. Normal recording shutdown and the public configuration are unchanged.
