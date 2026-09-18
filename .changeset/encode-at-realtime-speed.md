---
'wdio-puppeteer-video-service': patch
---

Keep video encoding faster than the capture on small CI runners. Puppeteer 24
chose FFmpeg's VP9 encoding speed from the host's CPU count, so a 4-CPU runner
encoded full-HD video at about 6-7 frames per second: slower than the capture.
The encoder fell further behind for the whole test, every recording stop timed
out after five seconds, each test waited about 35 more seconds, and retained
videos kept only the beginning of the test. Recordings now always use VP9's
fastest realtime speed, which Puppeteer already used on hosts with 16 or more
CPUs. On a busy full-HD test page this encoded about 13 times faster with
near-identical SSIM and a file about 2.7 times larger; other pages will differ.
A recorder stop timeout is now logged as one line instead of a stack trace.
