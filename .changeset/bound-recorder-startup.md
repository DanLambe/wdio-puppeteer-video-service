---
"wdio-puppeteer-video-service": patch
---

Observe encoder errors, exits and diagnostics immediately after spawning. Apply process-tree cleanup to failed starts, bound CDP attachment and screencast start to a shared 10-second deadline, and detach sessions that arrive after cancellation. Keep viewport restoration awaited, restore after partially failed viewport changes, and release partially created capture artifacts once.
