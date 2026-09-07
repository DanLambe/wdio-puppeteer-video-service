# Changelog

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
