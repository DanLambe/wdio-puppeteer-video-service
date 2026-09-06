---
'wdio-puppeteer-video-service': patch
---

Isolate global recording and processing capacity by WDIO invocation so abandoned
locks cannot exhaust later runs. Global limits now coordinate local workers of
one invocation; sharing `concurrency.lockDir` no longer throttles independent
invocations. Clean only the completed run's slot directory, including after
manifest/report errors.

Keep lease metadata immutable, preserve live-owner protection, bound acquisition
races and artifact naming retries, and distinguish storage failures from busy
capacity while releasing acquired resources.
