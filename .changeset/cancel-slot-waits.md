---
'wdio-puppeteer-video-service': patch
---

A deferred encode that stops waiting for a post-processing slot now stops the wait itself. Before, when the encode gave up after its 30-second slot wait, or was cancelled at shutdown, the wait for the slot kept going: a slot shared across workers (`concurrency.maxPostProcessesGlobal`, which the `ci` profile sets to 1) was still polled every 100 ms for up to 120 seconds. That kept a finished worker running, and once the slot freed it was taken and released unused. A cancelled wait now ends at once and takes nothing, and a freed slot goes to the next waiter.
