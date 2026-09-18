---
'wdio-puppeteer-video-service': patch
---

Record an incomplete capture (an encoder error, a killed encoder or a stop
timeout) in the manifest as `failed` with reason `capture-incomplete` instead
of as a successful recording. Retained partial media is still listed and
attached to Allure for diagnosis, but is not merged or queued for other
processing; media the retention policy discards is deleted as before. The
default `failurePolicy: 'warn'` keeps the single warning logged when the
segment stops and does not fail the test; `failurePolicy: 'error'` raises the
failure after manifest finalization and recording cleanup. The failure is
remembered across window segments of the same test and cleared before the next
recording.
