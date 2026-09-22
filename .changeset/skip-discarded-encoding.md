---
'wdio-puppeteer-video-service': patch
---

Stop draining the encoder for a recording that retention is about to delete.
With the default `recording.retain: 'failures'`, a passing test's recording was
stopped gracefully, so the encoder drained its remaining queue, flushed, and
finished writing a file that was deleted moments later. The encoder is now
terminated instead and the partial file removed.

Frames are encoded as they are captured, so this does not avoid the encoding
already done during the test. It removes the work at the end, which is largest
exactly where it hurts most: on a host whose encoder has fallen behind, that
drain is bounded only by the five second stop deadline.

The manifest is unchanged: such an entry was already recorded as `discarded`
with no segments and no post-processing.
