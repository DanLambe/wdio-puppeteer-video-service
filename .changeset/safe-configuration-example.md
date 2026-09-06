---
'wdio-puppeteer-video-service': patch
---

Make the README's configuration example safe to copy. It restated every option
at once, so a reader who used it as a starting point got a `capture.crop` larger
than the default viewport, which fails the recording outright; spec and tag
filters that silently record nothing unless a spec happens to match; an FFmpeg
path that only exists on some Linux hosts; and an Allure integration that
expects an optional peer they may not have installed. The example is now a
short, working configuration, and the Option Reference below it remains the
complete list.
