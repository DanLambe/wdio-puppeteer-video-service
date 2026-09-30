---
'wdio-puppeteer-video-service': patch
---

Report a recording as incomplete when FFmpeg exits before the recording is
stopped, even with exit code 0. The encoder never received the end of its
input, so it cannot have encoded the rest of the test; a configured FFmpeg
wrapper that ends early previously produced a short video that was accepted,
and transcoded, as a complete recording. The partial file is now kept as an
unclean segment, the manifest entry is `failed` with reason
`capture-incomplete`, and the warning names the exit code or signal with the
end of FFmpeg's error output.

Keep a capture failure that is already known when the retention policy discards
a passing test's recording, such as an overloaded or exited encoder. The
manifest records the entry as `failed` with reason `capture-incomplete` and no
segments, as the documentation already described, instead of as an ordinary
discard. The default `failurePolicy: 'warn'` logs one warning, and `'error'`
raises the failure after cleanup. A healthy discarded recording is still
terminated without draining the encoder.
