---
'wdio-puppeteer-video-service': patch
---

Apply a fast H.264 preset to MP4 transcoding in every profile. Without an
explicit preset libx264 falls back to `preset medium`, the most expensive
single step in the pipeline. Every profile now defaults to
`-preset veryfast -crf 23`, and `processing.transcode.ffmpegArgs` still wins
because configured arguments are appended last.

On a static UI clip, `veryfast` at CRF 23 took 1.43 s rather than 1.98 s for
SSIM 0.9855 against 0.9889 — most of the saving, for a small fidelity cost.
Dropping to CRF 28 as well bought only about 2% more time while SSIM fell to
0.9774, so the default keeps CRF 23. The `ci` profile continues to use CRF 28
for smaller artifacts, and keeps `-threads 1` so concurrent transcodes do not
each claim every core.
