# Troubleshooting

## WDIO launcher context is missing or malformed

Register the service by package name:

```typescript
services: [['puppeteer-video', options]]
```

Do not import the worker class into `services`. WDIO only discovers the
package's named launcher export when resolving a string or module path, and the
service rejects class-based registration before browser startup.

## No recording is created

- Confirm Chrome or Edge exposes CDP and the session is classified as
  `bidi+cdp` or `classic+cdp`.
- Cloud/grid sessions need a usable `se:cdp` endpoint. Multiremote, component
  runner, Firefox, Safari, mobile, and remote-debugging pipes are unsupported.
- Check recording filters and retry-only settings before increasing timeouts.

## FFmpeg is unavailable

Set `processing.ffmpeg.path` or `FFMPEG_PATH`, or put `ffmpeg` on `PATH`.
Development may install `ffmpeg-static`; it is deliberately not a production
dependency. CI should not opt out of FFmpeg media assertions.

## Merge or transcode fails

The service preserves source recordings and removes unpublished temporary
output. Enable debug logging, inspect the FFmpeg command/error, and verify free
disk space and codec support. Increase `processing.ffmpeg.timeoutMs` only when
the operation is demonstrably healthy but slow.

## Recording capacity is exhausted

Inspect `concurrency` recording and post-processing limits independently.
`maxPostProcessesPerProcess` must be a positive integer and defaults to `1`;
increase it only when the worker has enough CPU, memory, and I/O capacity for
concurrent FFmpeg work. `maxPostProcessesGlobal: 0` disables only the
cross-worker limit. Each operation still acquires its own per-process slot.
Cross-worker lock files carry heartbeats. A lease with a live owner PID is kept
even when its heartbeat is old; dead owners are reclaimed immediately, while
malformed locks must exceed the invalid-file grace period. Keep
`concurrency.lockDir` on storage shared by the participating local workers.

## Allure has no video

- Install and configure `@wdio/allure-reporter` in WDIO's reporter list.
- Use `recording.scope: 'test'` and `processing.timing: 'after-test'`.
- Ensure retention kept the video and `integrations.allure.maxBytes` did not
  exclude it.
- Use `attach: 'retained'` to attach passing retained recordings.

## The static report has a missing video

The report uses relative links and does not copy media. Preserve its directory
relationship to `manifest.json` and the recordings. Regenerate the report if
artifacts were moved or removed. Report generation checks that a media file
exists but does not decode or repair it; a file that exists but will not play
must be diagnosed from the preserved source media and FFmpeg logs.

## Windows path or filename errors

Use a short `outputDir` and the default truncation strategy. Session naming is
the fallback when a test-oriented name cannot fit the configured path budget.
