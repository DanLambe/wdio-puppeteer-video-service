---
'wdio-puppeteer-video-service': patch
---

The HTML report of a suite that also runs Firefox, Safari or multiremote workers no longer lists a diagnostic for every one of their tests. The service skips those workers before they start, so they have no manifest entries, and the report used to flag each of their outcomes as `unmatched-test-outcome`. The reporter now notes why such a worker is not recorded, and the report shows its tests with `capture: skipped` and that reason. A Chromium test with no capture is still flagged.
