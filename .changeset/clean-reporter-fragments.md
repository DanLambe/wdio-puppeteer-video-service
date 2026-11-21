---
'wdio-puppeteer-video-service': patch
---

Two clean-ups of files a run leaves behind:

- **Reporter fragments are removed once the report is written.** The reporter's per-worker files in `outputDir/.wdio-video-report/<run>` were never deleted, so they piled up locally run after run and were uploaded with the videos from CI. They now go once `video-report.html` is written, and stay if the report could not be written.
- **A discarded recording's earlier segments are deleted even when briefly locked.** When a recording with several segments was discarded, its earlier segments were each deleted with a single attempt, so on Windows a segment that a virus scanner or indexer still held open could stay behind in `outputDir`. They are now retried, as the last segment already was, and a file that stays locked is named in a warning.
