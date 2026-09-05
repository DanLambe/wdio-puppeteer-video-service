---
'wdio-puppeteer-video-service': patch
---

Preserve bounded waits for healthy-but-busy global capacity when another slot
has a storage fault. Retry transient slot errors within the existing deadline,
but fail immediately if all candidates have non-retryable errors. Keep storage
errors distinct from ordinary capacity timeouts and preserve media cleanup.

Clarify missing launcher-context diagnostics, classify slot-directory creation
failures with their causes, and reject unsafe run IDs before manifest directory
creation.
