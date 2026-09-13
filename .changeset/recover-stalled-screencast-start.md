---
'wdio-puppeteer-video-service': patch
---

Recover recordings whose screencast stalls right after a tab switch. When
capture starts on a tab whose activation just changed — a newly opened tab, or
the original tab after another one closes — Chrome can deliver the screencast's
first frame and then drop every frame that frame priming produces. A static page
never repaints after that, and Puppeteer, which encodes a frame only once the
next one arrives, writes an empty recording. Frame priming now confirms that a
second frame arrived and, if not, primes again once the tab has settled, within
a 1.5 second budget. Normal recordings, where priming already produces frames,
do no extra work. The confirmation relies on the CDP session Puppeteer's own
recorder uses; if that is unavailable, priming behaves as before. The public
configuration is unchanged.
