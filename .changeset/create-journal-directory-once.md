---
'wdio-puppeteer-video-service': patch
---

Create the worker manifest journal's directory once per run instead of on every
append. Two or three events are appended per test and the directory does not
come and go between them. A journal write that still finds the directory
missing recreates it and retries, so cleanup elsewhere in a run cannot silently
lose later events.
