---
'wdio-puppeteer-video-service': patch
---

Recover recordings whose screencast stalls right after a tab switch. When
capture starts on a tab whose activation just changed — a newly opened tab, or
the original tab after another one closes — Chrome can deliver the screencast's
first frame and then drop every frame that frame priming produces. A static page
never repaints after that, and Puppeteer, which encodes a frame only once the
next one arrives, writes an empty recording. Frame priming now confirms enough
timestamp-separated input frames for encoding and FFmpeg startup probing. When
needed, it primes again within a 1.5 second recovery scheduling budget at normal
frame rates, extended at very low FPS to allow three frame intervals plus
550 ms. In-flight viewport operations and restoration are awaited. Recordings
already producing enough frames do no extra work. Confirmation uses the CDP
session Puppeteer's own recorder uses; if that is unavailable, priming behaves
as before. The public configuration is unchanged.
