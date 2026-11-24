---
'wdio-puppeteer-video-service': patch
---

The HTML report is easier to use on larger suites:

- A search box filters the tests by name, spec, browser or error message, alongside the existing filters.
- The summary shows how many videos the report holds and their total size, and links `manifest.json` when it sits beside the report.
- In a report with more than 20 videos, each loads only when played (`preload="none"`), so opening a large report from disk or a downloaded CI artifact no longer reads every video's metadata at once.
