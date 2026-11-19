---
'wdio-puppeteer-video-service': patch
---

A tab move no longer transcodes the segment it ends. Before, with `format: 'mp4'` and the default `processing.timing: 'after-test'`, the command that moved recording to another tab waited while the previous segment was transcoded, and if the test then passed under `retain: 'failures'` that work was thrown away. Segments are now processed when the test ends, only when the recording is kept; a discarded recording is not transcoded or merged. Kept recordings produce the same files and manifest entries as before.
