---
"wdio-puppeteer-video-service": patch
---

Send each distinct screencast frame to the encoder once, stamped with its place on the `capture.fps` grid, instead of re-sending an unchanged page at every grid position. On a two-CPU runner this cut recording CPU by about 40% and FFmpeg CPU by about 70%, reduced retained file sizes by about 80%, and removed the recorder stop timeouts a four-worker suite still hit. Videos keep real-time playback and hold an unchanged page as one frame, so their frame rate varies up to `capture.fps`. Recordings are now VP9 in 4:2:0 color, which Safari and hardware decoders can play, rather than planar RGB. H.264 transcodes keep each frame's timestamp, using the option spelling the detected FFmpeg supports, from 4.4 onward. Encoder input waits for the encoder instead of buffering without limit, and frames waiting for it are bounded per recording; an encoder that falls too far behind stops capture and reports the recording as incomplete.
