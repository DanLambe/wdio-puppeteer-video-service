---
'wdio-puppeteer-video-service': patch
---

Record videos that play back in real time at the configured `capture.fps`.
Puppeteer 24's screen recorder, which the service used until now, encoded every
video at 25 fps whatever `capture.fps` was: at the default 30 FPS playback ran
about 20% slow, and at 10 FPS it ran about 2.5 times too fast. It also rounded
each gap between captured frames on its own, so a page that repaints faster
than `capture.fps` lost most of its frames: at the `ci` and `parallel` profiles'
24 FPS a continuously animated page could be recorded as a single frozen frame.
Its FFmpeg input settings also discarded the first two frames of every
recording, and it dropped the last frame received before stopping.

The service now records the screencast itself. Frames are placed on a
constant-frame-rate timeline, FFmpeg receives the frame rate as an input option
and keeps every frame, and the final page state is held until the recording
stops. Crop, scale, speed, quality, output formats and the public configuration
are unchanged, and Puppeteer Core remains the CDP connection. Frame priming now
retries only when the screencast has delivered just its first frame.
