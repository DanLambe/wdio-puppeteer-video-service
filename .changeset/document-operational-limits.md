---
'wdio-puppeteer-video-service': patch
---

Correct and extend the operational guidance. Manual slot-directory housekeeping
now distinguishes the default base this service owns entirely from a configured
`concurrency.lockDir`, which is used exactly as given and may hold videos,
manifests, or unrelated files; only service-created run subdirectories should be
removed under a custom base. A new section explains that a recording which ends
with a single frame and zero duration is retained deliberately and may not play
normally, which is not the same as being corrupt. `integrations.allure.maxBytes`
now documents what it costs and protects: there is no default cap, each
attachment is read into memory whole because the reporter accepts buffer content
rather than a stream, and an oversize attachment is skipped with a warning while
its recording stays on disk, in the manifest, and in the static report. No
behaviour change.
