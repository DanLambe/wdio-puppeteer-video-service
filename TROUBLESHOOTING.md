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

## Capture crop does not fit the viewport

`capture.crop` is checked against the viewport at screencast startup. Its
right and bottom edges must fit within that viewport, not just its width and
height in isolation. Reduce the crop or adjust `capture.viewport`. An explicit
capture viewport is temporary and is restored after initialization, including
when Puppeteer rejects the crop. The diagnostic retains Puppeteer's original
error as its cause; unrelated browser or FFmpeg failures are not labeled crop
errors.

## Manifest video dimensions are missing or differ from the viewport

Dimensions come from the retained encoded file. Browser device pixel ratio,
Puppeteer scaling, H264 padding, and custom processing filters can make them
different from CSS viewport dimensions. Deferred inputs have no dimensions
until processing completes. Missing, empty, or uninspectable files omit these
optional fields rather than guessing; the video itself is preserved.

Look for metadata-probe or post-processing-capacity warnings and verify FFmpeg
can read the retained file. A metadata probe uses a post-processing slot and
has a 5-second execution limit (or a shorter positive
`processing.ffmpeg.timeoutMs`). Setting that option to `0` does not disable the
metadata limit. Optional metadata failures warn even under the error policy.

A probe's spawn or inspection failure does not disable subsequent recording or
essential FFmpeg processing and does not imply that FFmpeg needs reinstalling.
If the runtime is already unavailable, the metadata-specific omission warning
is emitted once per session. The existing essential-processing failure policy
is unchanged.

The execution limit excludes slot acquisition. Probes honor both per-process
and configured global post-processing limits for the current invocation. The
default blocking global wait can last up to 120 seconds;
`concurrency.postProcessStartTimeoutMs` controls fast-fail acquisition. Busy
capacity can therefore delay metadata or leave dimensions absent. Do not
interpret optional missing dimensions alone as a corrupt video.

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
The publication warning includes the filesystem error code (for example `EPERM`,
`EXDEV`, or `ENOTSUP`) and `outputDir` guidance. Permission errors can also mean
the directory is not writable or security software is blocking the operation;
they do not by themselves prove the filesystem lacks hard-link support. No
rename fallback is attempted, because it could overwrite another worker's file.

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
slots. A faulty candidate does not abandon the wait for other healthy-but-busy
slots. Transient slot errors (`EBUSY`, `EAGAIN`, `EMFILE`, `ENFILE`, and Windows
`EPERM`) are retried with the normal polling interval until the existing deadline.
This does not guarantee they will recover. If every candidate has a non-retryable
error (for example `EACCES` or `ENOSPC`), acquisition fails immediately. Directory
creation failures also fail immediately. At the deadline, unresolved errors are
reported with their original causes; recovered errors do not turn a later pure
capacity timeout into a storage failure. Check the reported path and permissions
instead of raising the wait timeout for persistent failures.

If global limits report a missing launcher context, register the service through
`services: [['puppeteer-video', options]]`; a worker constructed without launcher
configuration cannot safely share global slots. Unsafe run identifiers are
rejected before slot or manifest directory creation.

If artifact naming exhausts 1,000 candidates, choose
a fresh output directory or a more distinctive naming style; existing artifacts
are not overwritten. Persistent artifact reservations and manifest aggregation
locks still conservatively respect live PIDs, independently of slot run isolation.
They also share the transient-error classification above: a momentary refusal
while opening a lock file is treated as contention rather than a fault. Manifest
aggregation polls within its existing deadline, and an artifact reservation waits
briefly on the same candidate path instead of renaming the artifact, because a
descriptor shortage is not a name collision and another name would meet the same
refusal. An already-occupied path still advances to the next candidate name, a
genuine fault such as `EACCES` or `ENOSPC` still fails immediately, and a wait
that ends without the refusal clearing reports the underlying filesystem error as
its cause.

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
