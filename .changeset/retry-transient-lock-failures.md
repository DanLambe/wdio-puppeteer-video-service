---
'wdio-puppeteer-video-service': patch
---

Keep a run's manifest, report, and recording names when a momentary filesystem
refusal interrupts lock acquisition. Manifest aggregation and artifact
reservation now treat the transient error class the global slot scheduler
already retries - `EBUSY`, `EAGAIN`, `EMFILE`, `ENFILE`, and a Windows `EPERM`
sharing violation - as contention rather than a fault. Aggregation polls within
its existing deadline instead of failing on the first attempt, and a reservation
waits up to two seconds on the same candidate path instead of renaming the
artifact: a descriptor shortage is not a name collision, so another name would
meet the same refusal. Genuine faults such as `EACCES` and `ENOSPC` still fail
closed immediately, an occupied path still advances to the next candidate, and a
reservation that never clears now reports the underlying filesystem error
instead of an exhausted candidate limit.
