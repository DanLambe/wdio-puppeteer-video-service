---
"wdio-puppeteer-video-service": patch
---

Stop publishing declaration maps that reference package-external TypeScript
sources, and harden the release workflow against publishing a prerelease on the
stable npm channel or a stable version on the prerelease channel.
