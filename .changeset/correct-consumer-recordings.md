---
"wdio-puppeteer-video-service": patch
---

Fix retained-video metadata and report links when `outputDir` is relative to the
worker's working directory, including deferred processing. Keep runtime skipped
tests marked as skipped and do not retain them as failures or attach them to
failure-only Allure reports.

Recover recording startup when WebdriverIO's automatic tab-close switch overlaps
navigation and destroys the page-marker script context. Retry only marker
creation once for known context-destruction errors, before allocating media, and
avoid duplicate recording restarts on an already active window.
