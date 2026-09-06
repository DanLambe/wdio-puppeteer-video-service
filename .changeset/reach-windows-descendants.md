---
'wdio-puppeteer-video-service': patch
---

Reach the FFmpeg process tree on Windows when an operation times out or the
service tears down. A failed graceful `taskkill /T` used to fall back to
signalling the FFmpeg process itself, which on Windows is an abrupt
single-process terminate: the run settled as soon as that parent closed, so the
forced tree pass never ran and any descendant a wrapper or custom executable had
spawned was left behind. The graceful attempt now leaves the tree intact, so the
existing grace period and forced pass can still reach it, and the child is
signalled only as the forced pass's last resort.

Termination remains best effort rather than a containment guarantee. A wrapper
that exits on its own during the grace period, or a `taskkill` helper that is
missing or hangs, can still strand a detached descendant, because a dead or
unreachable parent cannot be used to enumerate its children.
