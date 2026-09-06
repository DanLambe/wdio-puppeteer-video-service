---
'wdio-puppeteer-video-service': patch
---

Read optional manifest dimensions from finalized retained videos with a bounded,
metadata-only FFmpeg inspection. Account for device pixel ratio, crop/scale
rounding, H264 padding, custom filters, and deferred outputs without decoding or
probing discarded videos. Preserve media when optional metadata is unavailable.

Add actionable crop-bound diagnostics while preserving viewport restoration and
the original cause. Verify offline report playback and iframe-to-window capture
with the existing browser fixtures.
