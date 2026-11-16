---
'wdio-puppeteer-video-service': patch
---

New option `capture.encoding` (`'live'`, `'auto'` or `'deferred'`, default `'live'`). With `'deferred'`, no encoder runs while a test runs: its frames are written to disk, deleted unencoded if the recording is discarded, and encoded when the test ends if it is kept. `'auto'` does this only for recordings that may be discarded, such as passing tests under `retain: 'failures'`, and encodes the rest live. Kept recordings produce the same files and manifest entries as live ones. A kept recording that cannot be encoded keeps its frames as a `.frames.mkv` file, with a warning that says how to convert it, and is reported as incomplete. The default, `'live'`, records as before.
