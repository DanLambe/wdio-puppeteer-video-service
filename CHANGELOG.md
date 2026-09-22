# Changelog

## 1.0.0-rc.5

### Minor Changes

- a52bda6: Add `capture.maxWidth` and `capture.maxHeight`, which cap the dimensions Chrome
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

### Patch Changes

- a52bda6: Create the worker manifest journal's directory once per run instead of on every
  append. Two or three events are appended per test and the directory does not
  come and go between them. A journal write that still finds the directory
  missing recreates it and retries, so cleanup elsewhere in a run cannot silently
  lose later events.
- a52bda6: Decode screencast frames only when they are written to the encoder. Chrome
  delivers frames faster than `capture.fps` on a busy page, and a frame
  superseded before the timeline advanced was still being turned into a buffer
  that nothing consumed.
- a52bda6: Apply a fast H.264 preset to MP4 transcoding in every profile. Without an
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

- a52bda6: Stop draining the encoder for a recording that retention is about to delete.
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

- a52bda6: Stop spending encoder time on capture filters that change nothing. `capture.scale` and
  `capture.speed` both resolve to `1` when they are not configured, and `1` is truthy, so every
  default recording built a filter chain containing `setpts=1*PTS` and
  `scale=iw*1:-1:flags=lanczos` and paid for a full Lanczos resample on every frame to produce the
  frame it already had. Both filters are now emitted only when they would actually change the output.

  Recorded video decodes to pixel-identical frames, verified with FFmpeg per-frame checksums, and a
  configured `scale` or `speed` is unaffected. On a 1080p frame at 24 fps, encoding 100 frames went
  from 2724 ms to 2589 ms (best of three).

## 1.0.0-rc.4

### Patch Changes

- cdde62d: Cancel stalled recording shutdown without leaving the encoder running. After
  the existing five-second graceful-stop deadline, terminate the recording's
  owned FFmpeg process tree and settle pending recorder work. Close the output
  file while preserving bytes already written, and mark the segment unclean so
  it is not transcoded as a completed capture. This avoids a redundant stream
  completion timeout and prevents an abandoned encoder from keeping a worker
  alive. Normal recording shutdown and the public configuration are unchanged.
- cdde62d: Keep video encoding faster than the capture on small CI runners. Puppeteer 24
  chose FFmpeg's VP9 encoding speed from the host's CPU count, so a 4-CPU runner
  encoded full-HD video at about 6-7 frames per second: slower than the capture.
  The encoder fell further behind for the whole test, every recording stop timed
  out after five seconds, each test waited about 35 more seconds, and retained
  videos kept only the beginning of the test. Recordings now always use VP9's
  fastest realtime speed, which Puppeteer already used on hosts with 16 or more
  CPUs. On a busy full-HD test page this encoded about 13 times faster with
  near-identical SSIM and a file about 2.7 times larger; other pages will differ.
  A recorder stop timeout is now logged as one line instead of a stack trace.
- cdde62d: Encode a static page's video while the test runs instead of at stop. Chrome
  sends no screencast frames while nothing on the page changes, so the recorder
  only wrote the held frame's repetitions when the next frame arrived or the
  recording stopped. A test that left a full-HD page unchanged for a minute at
  30 FPS therefore had about 1,800 frames to encode inside the five-second stop
  deadline; the stop timed out and the video kept about 34 of its 60 seconds. The
  held frame is now fed to the encoder every 250 ms, half a second behind real
  time so a late frame still starts at its own timestamp, and not while the
  encoder is backed up. The same test now stops in about 0.3 seconds with all 60
  seconds.

  A recording whose encoder exits with an error or is killed by a signal is no
  longer treated as complete: the service reports the exit code or signal with
  the end of FFmpeg's error output, keeps the file's bytes as an unclean segment,
  and does not transcode it. Error output split across a multibyte character is
  now decoded correctly.

- cdde62d: Keep a recording as long as its capture when Chrome delivers screencast frames
  late. The final frame was held only until its own timestamp plus the time since
  it arrived, so a frame delivered a second late ended the video a second early.
  At stop, the final frame is now also held until the time elapsed since the
  first frame arrived. Frames are still placed at their own timestamps while
  recording, so late frames on a busy page are not dropped.
- cdde62d: Record videos that play back in real time at the configured `capture.fps`.
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

- cdde62d: Record an incomplete capture (an encoder error, a killed encoder or a stop
  timeout) in the manifest as `failed` with reason `capture-incomplete` instead
  of as a successful recording. Retained partial media is still listed and
  attached to Allure for diagnosis, but is not merged or queued for other
  processing; media the retention policy discards is deleted as before. The
  default `failurePolicy: 'warn'` keeps the single warning logged when the
  segment stops and does not fail the test; `failurePolicy: 'error'` raises the
  failure after manifest finalization and recording cleanup. The failure is
  remembered across window segments of the same test and cleared before the next
  recording.
- cdde62d: Wait for a just-launched browser to draw before its first test is recorded. On
  a fresh machine a browser's first launch can take seconds to draw anything: on
  hosted Windows runners the first frame took up to about 12 seconds. Recording
  waits only about a second for a first frame, so a short first test could end
  before anything was drawn and leave an empty recording. When a Chromium session
  starts, after connecting and locating its page, the service now waits once,
  before the first test, up to 20 seconds for a paint request to confirm render
  readiness, and warns if it times out. Both warm-up and frame-priming paint
  requests use disposable CDP sessions so timeouts do not leave Puppeteer's
  shared screenshot lock blocking later test operations. Puppeteer's
  recorder in earlier releases instead waited without limit for the first frame
  inside the first test, where the delay counted toward that test's timeout.

## 1.0.0-rc.3

### Patch Changes

- Recover screencasts that stall immediately after a tab switch. Verify enough
  timestamp-separated input frames to pass Puppeteer's FFmpeg startup probing,
  rather than assuming that two received frames produce video. Retry priming only
  when needed, with an FPS-aware scheduling budget and viewport restoration.
  Keep the public configuration unchanged and cover low-FPS static capture with
  decoded-media regression tests.

- bb976b6: Fix retained-video metadata and report links when `outputDir` is relative to the
  worker's working directory, including deferred processing. Keep runtime skipped
  tests marked as skipped and do not retain them as failures or attach them to
  failure-only Allure reports.

  Recover recording startup when WebdriverIO's automatic tab-close switch overlaps
  navigation and destroys the page-marker script context. Retry only marker
  creation once for known context-destruction errors, before allocating media, and
  avoid duplicate recording restarts on an already active window.

- bb976b6: Request a bounded compositor paint during frame priming so static tabs have an
  opportunity to emit more than the initial screencast frame. The unclipped,
  low-quality viewport snapshot is discarded in memory, not used to encode video.
  Restore the original viewport even if warmup is interrupted and clear the paint
  deadline. The public configuration and frame-priming default are unchanged.

## 1.0.0-rc.2

### Patch Changes

- ab55b06: Read optional manifest dimensions from finalized retained videos with a bounded,
  metadata-only FFmpeg inspection. Account for device pixel ratio, crop/scale
  rounding, H264 padding, custom filters, and deferred outputs without decoding or
  probing discarded videos. Preserve media when optional metadata is unavailable.

  Add actionable crop-bound diagnostics while preserving viewport restoration and
  the original cause. Verify offline report playback and iframe-to-window capture
  with the existing browser fixtures.

- ab55b06: Create the GitHub release tag at the exact commit the release was validated and
  built from. The release step named a tag but no target, and the create-release
  API tags the default branch's current tip when the tag is new, so a `master`
  that advanced while the publish job waited for its protected-environment
  approval could leave the tag, its source archives, and the published tarball's
  provenance describing different commits. The publish job now also refuses to
  continue when a tag for that version already exists at another commit, because
  an existing tag makes the target inert; it never moves or deletes one.
- ab55b06: Skip optional end-of-test transcoding for recordings that the retention policy
  will discard, while preserving retained and mid-test window-segment processing.
  Also cancel the write-stream completion timer after the stream settles.
- ab55b06: Give each same-named Cucumber scenario its own media in the static report.
  Because Cucumber emits one reporter outcome per step, the report joined every
  step to the first manifest entry whose scenario title matched, so two scenarios
  sharing a title — including expanded Scenario Outline rows — both showed the
  first scenario's recording and the second capture was reported as unmatched.
  The report now assigns a scenario to the next unclaimed matching entry on its
  first step and reuses that assignment for the scenario's remaining steps.
- ab55b06: Correct and extend the operational guidance. Manual slot-directory housekeeping
  now distinguishes the default base this service owns entirely from a configured
  `concurrency.lockDir`, which is used exactly as given and may hold videos,
  manifests, or unrelated files; only service-created run subdirectories should be
  removed under a custom base. A new section explains that a recording which ends
  with a single frame and zero duration is retained deliberately and may not play
  normally, which is not the same as being corrupt. `integrations.allure.maxBytes`
  now documents what it costs and protects: there is no default cap, each
  attachment is read into memory whole because the reporter accepts buffer content
  rather than a stream, and an oversize attachment is skipped with a warning while
  its recording stays on disk, in the manifest, and in the static report. No
  behaviour change.
- ab55b06: Document the artifact reservation wait alongside the existing 1,000-candidate
  limit, so the concurrency reference describes what actually happens when a
  reservation is refused momentarily rather than only when a name is occupied. No
  behaviour change.
- ab55b06: Account for retries in a framework-neutral way. Cucumber never reports an
  attempt number of its own, so a retried scenario previously resolved to attempt
  1 again: `recording.retain: 'retries'` could discard the retry recording, and
  manifest attempts and static-report joins could be ambiguous. Retry inference
  now runs for every `recording.attempts` mode and is keyed on a framework
  entity id where one exists, so a Cucumber retry reuses its pickle id while
  distinct same-named scenarios stay separate. Mocha keeps using its own
  `_currentRetry` value, and the reporter now also reads a scenario retry from
  the enclosing suite so manifest and report attempts stay joinable.
- ab55b06: Isolate global recording and processing capacity by WDIO invocation so abandoned
  locks cannot exhaust later runs. Global limits now coordinate local workers of
  one invocation; sharing `concurrency.lockDir` no longer throttles independent
  invocations. Clean only the completed run's slot directory, including after
  manifest/report errors.

  Keep lease metadata immutable, preserve live-owner protection, bound acquisition
  races and artifact naming retries, and distinguish storage failures from busy
  capacity while releasing acquired resources.

- ab55b06: Allow the static report's own style and script blocks by SHA-256 hash instead of
  a nonce. A nonce is only worth anything when it is unpredictable, and a report
  generated once and read from disk has no per-request secret to derive one from,
  so the previous value was reproducible from the report itself. The digests are
  computed from the exact emitted text, so an edited or tampered block stops
  matching and the browser refuses to run it, and the report stays byte-identical
  across runs. The ineffective `frame-ancestors` directive is dropped, because a
  policy delivered in a `<meta>` element cannot carry it; hosts that need to
  restrict embedding should send a response header. Escaping is unchanged and
  remains the primary defense.
- ab55b06: Prevent optional retained-video metadata probe failures from disabling FFmpeg
  for later recordings, transcodes, and merges. Keep existing essential-processing
  failure behavior unchanged and warn once per session when metadata is skipped
  because the FFmpeg runtime is unavailable. Clarify metadata capacity waits and
  the optional dimension-field contract.
- ab55b06: Stop publishing declaration maps that reference package-external TypeScript
  sources, and harden the release workflow against publishing a prerelease on the
  stable npm channel or a stable version on the prerelease channel.
- ab55b06: Preserve bounded waits for healthy-but-busy global capacity when another slot
  has a storage fault. Retry transient slot errors within the existing deadline,
  but fail immediately if all candidates have non-retryable errors. Keep storage
  errors distinct from ordinary capacity timeouts and preserve media cleanup.

  Clarify missing launcher-context diagnostics, classify slot-directory creation
  failures with their causes, and reject unsafe run IDs before manifest directory
  creation.

- ab55b06: Pin the crop-bound diagnostic against the installed Puppeteer with a real browser
  check. The service recognizes Puppeteer's crop errors by their message prefix,
  and the unit test asserted against a copy of that wording, so an upstream
  rewording would have silently dropped the guidance while the suite stayed green.
  The check runs in every capture mode, including against the minimum supported
  Puppeteer. No behaviour change.
- ab55b06: Align Puppeteer Core support with WebdriverIO v9's supported 24.x range while
  preserving the existing screencast controls and recording behavior. The tested
  floor remains 24.11.2 because Puppeteer Core 24.0.0 does not expose or apply the
  `format`, `fps`, and `quality` screencast controls used by the service.
- ab55b06: Reach the FFmpeg process tree on Windows when an operation times out or the
  service tears down. A failed graceful `taskkill /T` used to fall back to
  signalling the FFmpeg process itself, which on Windows is an abrupt
  single-process terminate: the run settled as soon as that parent closed, so the
  forced tree pass never ran and any descendant a wrapper or custom executable had
  spawned was left behind. The graceful attempt now leaves the tree intact, so the
  existing grace period and forced pass can still reach it, and the child is
  signalled only as the forced pass's last resort.

  Termination remains best effort rather than a containment guarantee. A wrapper
  that exits on its own during the grace period, or a `taskkill` helper that is
  missing or hangs, can still strand a detached descendant, because a dead or
  unreachable parent cannot be used to enumerate its children.

- ab55b06: Remove production code that no longer had a caller: two unused recording
  lifecycle members, a superseded filter entry point, eight option normalizers
  replaced by option validation, and an inert merge-profile branch that could not
  change its own result. Behaviour is unchanged; the removed symbols were internal
  and never part of the published API. Coverage thresholds are re-ratcheted to
  96% statements and lines, 95% functions, and 93% branches now that the dead code
  and its tests are gone.
- ab55b06: Keep a run's manifest, report, and recording names when a momentary filesystem
  refusal interrupts lock acquisition. Manifest aggregation and artifact
  reservation now treat the transient error class the global slot scheduler
  already retries - `EBUSY`, `EAGAIN`, `EMFILE`, `ENFILE`, and a Windows `EPERM`
  sharing violation - as contention rather than a fault. Aggregation polls within
  its existing deadline instead of failing on the first attempt, and a reservation
  waits up to two seconds on the same candidate path instead of renaming the
  artifact: a descriptor shortage is not a name collision, so another name would
  meet the same refusal. Genuine faults such as `EACCES` and `ENOSPC` still fail
  closed immediately, an occupied path still advances to the next candidate, and a
  reservation that never clears now reports the underlying filesystem error
  instead of an exhausted candidate limit.
- ab55b06: Make the README's configuration example safe to copy. It restated every option
  at once, so a reader who used it as a starting point got a `capture.crop` larger
  than the default viewport, which fails the recording outright; spec and tag
  filters that silently record nothing unless a spec happens to match; an FFmpeg
  path that only exists on some Linux hosts; and an Allure integration that
  expects an optional peer they may not have installed. The example is now a
  short, working configuration, and the Option Reference below it remains the
  complete list.
- ab55b06: Explain hard-link publication failures with filesystem error codes and output
  directory guidance while preserving source media and no-clobber behavior. Add
  focused worker teardown/reload tests and bounded Windows advanced and real
  process-tree checks to PR and release validation.

This project uses [Changesets](https://github.com/changesets/changesets) for
versioning and release notes.

## 1.0.0-rc.1

- Split the WDIO v9 plugin into a named launcher export and a worker-only
  default export. Canonical registration is now
  `services: [['puppeteer-video', options]]`, with versioned launcher-to-worker
  run and retry context transport.
- Replaced the flat beta configuration with validated recording, capture,
  processing, concurrency, artifact, and integration groups.
- Added an idempotent recording lifecycle with crash-safe cleanup and separate
  recording/post-processing capacity limits, including recovery after partial
  startup and teardown failures.
- Added Puppeteer screencast viewport, frame-rate, quality, scale, speed, crop, priming,
  and connection-timeout controls.
- Added WDIO v9 Chrome BiDi/classic CDP classification and Edge smoke support.
- Added exclusive artifact reservation, ownership-safe no-clobber merge/transcode publication,
  source-media preservation, ownership-safe lock recovery, and bounded UTF-8
  FFmpeg diagnostics.
- Added bounded deferred post-processing with a positive per-worker limit,
  enqueue-order failure reporting after the full queue settles, and independent
  global leases for concurrent FFmpeg operations.
- Added Manifest v1, the offline static HTML reporter, and optional Allure video
  attachments, with consistent cleanup-first failure-policy handling.
- Modularized manifest context transport, crash-tolerant journals, aggregation,
  persistence, report modeling, and deterministic HTML rendering without
  changing Manifest v1.
- Hardened retry retention and reporting, cleanup-first recording failures,
  capture preservation on filesystem errors, manifest path and journal safety,
  cross-process lease recovery, and release-validation identity checks.
- Added deterministic Mocha, Jasmine, and Cucumber media validation with local
  same-origin and cross-origin fixtures.
- Prepared an ESM-only Node.js 24 package with root, manifest, and reporter
  exports.

See [MIGRATION.md](./MIGRATION.md) for the clean-breaking 0.8 migration.
