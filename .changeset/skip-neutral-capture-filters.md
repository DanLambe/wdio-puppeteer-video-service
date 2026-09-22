---
'wdio-puppeteer-video-service': patch
---

Stop spending encoder time on capture filters that change nothing. `capture.scale` and
`capture.speed` both resolve to `1` when they are not configured, and `1` is truthy, so every
default recording built a filter chain containing `setpts=1*PTS` and
`scale=iw*1:-1:flags=lanczos` and paid for a full Lanczos resample on every frame to produce the
frame it already had. Both filters are now emitted only when they would actually change the output.

Recorded video decodes to pixel-identical frames, verified with FFmpeg per-frame checksums, and a
configured `scale` or `speed` is unaffected. On a 1080p frame at 24 fps, encoding 100 frames went
from 2724 ms to 2589 ms (best of three).
