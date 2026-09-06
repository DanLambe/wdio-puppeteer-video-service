---
'wdio-puppeteer-video-service': patch
---

Remove production code that no longer had a caller: two unused recording
lifecycle members, a superseded filter entry point, eight option normalizers
replaced by option validation, and an inert merge-profile branch that could not
change its own result. Behaviour is unchanged; the removed symbols were internal
and never part of the published API. Coverage thresholds are re-ratcheted to
96% statements and lines, 95% functions, and 93% branches now that the dead code
and its tests are gone.
