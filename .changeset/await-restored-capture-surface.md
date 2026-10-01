---
'wdio-puppeteer-video-service': patch
---

Wait for the restored browser surface to paint whenever the page's viewport is restored while a recording starts. Chrome's screencast could otherwise stop delivering frames, so the first static test's video stayed blank while the manifest reported a healthy recording. Frame priming now makes a second bounded paint (up to 500 ms) after restoring the viewport. An explicit `capture.viewport` is also followed by one bounded paint once the screencast has started, which covers the `ci` profile and any recording with `capture.framePriming: false`. In a reproduction with minimum supported peers under BiDi, blank recordings dropped from 5 in 10 (primed) and 9 in 10 (unprimed, explicit viewport) to none. If paint requests never complete, frame priming can now take about 3.4 seconds instead of about 2.5 seconds.
