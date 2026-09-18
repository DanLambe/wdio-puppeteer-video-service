---
'wdio-puppeteer-video-service': patch
---

Keep a recording as long as its capture when Chrome delivers screencast frames
late. The final frame was held only until its own timestamp plus the time since
it arrived, so a frame delivered a second late ended the video a second early.
At stop, the final frame is now also held until the time elapsed since the
first frame arrived. Frames are still placed at their own timestamps while
recording, so late frames on a busy page are not dropped.
