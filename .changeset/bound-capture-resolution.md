---
'wdio-puppeteer-video-service': minor
---

Add `capture.maxWidth` and `capture.maxHeight`, which cap the dimensions Chrome
is asked to produce for each screencast frame. Chrome scales the frame to fit,
preserving aspect ratio, before it leaves the browser, so a smaller frame is
encoded, transferred, and decoded. This bounds the frame, not the page: layout
and paint are unchanged, and the viewport is not resized. A frame already
inside the bound is untouched.

The `ci` profile defaults `capture.maxWidth` to `1280` unless a bound is
configured. Encoding a real captured page at 720p rather than 1080p measured
about 2.2 times the throughput with output about 47% smaller, under a
two-CPU quota with four concurrent encoders. That figure is encoder-only and
uses a repeated still frame, so it is not a claim about animated pages or about
whole-suite time. Set `capture.maxWidth` or `capture.maxHeight` explicitly to
choose your own bound.

`capture.crop` cannot be combined with a bound, and is rejected before capture
starts. Chrome applies the bound against the viewport of each frame, so a crop
rectangle fixed when capture starts selects the wrong region as soon as the
viewport changes — including the restore that `capture.viewport` performs. The
`ci` profile's default bound is not applied to a cropped recording. Use
`capture.scale` to resize a cropped recording.
