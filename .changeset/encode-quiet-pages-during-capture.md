---
'wdio-puppeteer-video-service': patch
---

Encode a static page's video while the test runs instead of at stop. Chrome
sends no screencast frames while nothing on the page changes, so the recorder
only wrote the held frame's repetitions when the next frame arrived or the
recording stopped. A test that left a full-HD page unchanged for a minute at
30 FPS therefore had about 1,800 frames to encode inside the five-second stop
deadline; the stop timed out and the video kept about 34 of its 60 seconds. The
held frame is now fed to the encoder every 250 ms, half a second behind real
time so a late frame still starts at its own timestamp, and not while the
encoder is backed up. The same test now stops in about 0.3 seconds with all 60
seconds.

A recording whose encoder exits with an error or is killed by a signal is no
longer treated as complete: the service reports the exit code or signal with
the end of FFmpeg's error output, keeps the file's bytes as an unclean segment,
and does not transcode it. Error output split across a multibyte character is
now decoded correctly.
