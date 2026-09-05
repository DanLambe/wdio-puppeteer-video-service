# Troubleshooting

## npm reports a Puppeteer peer-dependency conflict

Install a Puppeteer Core version supported by both this service and
WebdriverIO v9:

```bash
npm install --save-dev puppeteer-core@^24.11.2
```

WebdriverIO `9.31.1` corrected its Puppeteer peer range to exclude version 25.
Earlier WebdriverIO releases used an overly broad range that could allow an
unsupported Puppeteer 25 installation. Do not bypass the conflict with
`--force`, `--legacy-peer-deps`, or an override. Keep WebdriverIO on a supported
9.x release and use Puppeteer Core `>=24.11.2 <25`.

The lower bound is not only a peer-resolution preference. Puppeteer Core
24.0.0 does not expose or apply the `format`, `fps`, and `quality` screencast
controls required by the service, so widening the range to all 24.x releases
would silently ignore configured capture behavior.

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

Final output publication uses a hard link so a concurrent worker can never
overwrite an existing artifact. FAT/exFAT, some network shares, container bind
mounts, or restricted filesystems may reject hard links. Move `outputDir` to a
local hard-link-capable filesystem when diagnostics report an unsupported link
operation. The service preserves the source recording in this case.

## Recording capacity is exhausted

Inspect `concurrency` recording and post-processing limits independently.
`maxPostProcessesPerProcess` must be a positive integer and defaults to `1`;
increase it only when the worker has enough CPU, memory, and I/O capacity for
concurrent FFmpeg work. `maxPostProcessesGlobal: 0` disables only the
cross-worker limit. Each operation still acquires its own per-process slot.
Global limits cover workers within one WDIO invocation on the same host/PID
namespace. Keep `concurrency.lockDir` on local storage shared by those workers.
The launcher creates a unique run subdirectory, with recording slots at
`<lockDir>/<runId>/slot-N.lock` and processing slots beneath `post-process/`.
Separate invocations do not share capacity; use CI job limits for a host-wide
budget. The run identity is available even if manifest setup fails.

Lease metadata is written once. A lease with a live owner PID is kept regardless
of age; dead owners are reclaimed immediately, while malformed locks must exceed
the invalid-file grace period. Never delete a live run's locks to clear capacity:
that can allow two workers to use the same slot. PID reuse within a very long
invocation can still strand a slot conservatively; stop that invocation before
removing its directory. A later invocation uses fresh capacity. Normal launcher
completion removes only its own run directory, including after manifest/report
errors. If the launcher crashes, its old directory may remain but cannot block
a new run. Remove abandoned directories only after confirming their runs ended.

Permission, read/write, and directory failures are operational errors, not busy
slots. Check the reported path and filesystem permissions instead of raising
the capacity wait timeout. If artifact naming exhausts 1,000 candidates, choose
a fresh output directory or a more distinctive naming style; existing artifacts
are not overwritten. Persistent artifact reservations and manifest aggregation
locks still conservatively respect live PIDs, independently of slot run isolation.

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

## Manifest or report generation is disabled

The launcher preserves existing valid run records in `manifest.json`. A
truncated, malformed, or unsupported future-schema manifest is not overwritten;
manifest aggregation and report generation warn and stop under
`failurePolicy: 'warn'`, or fail the run under `'error'`. Move the invalid file
aside, inspect or recover it, and rerun to create a new manifest. Long-lived
output directories accumulate run records until the manifest is archived or
removed explicitly.

## Windows path or filename errors

Use a short `outputDir` and the default truncation strategy. Session naming is
the fallback when a test-oriented name cannot fit the configured path budget.
