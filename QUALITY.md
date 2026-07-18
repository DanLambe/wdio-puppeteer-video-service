# Quality Baseline

This file records the pre-1.0 quality floor. Each implementation chunk must meet
or improve this floor and publish its own test and SonarQube checkpoint results.

## Chunk 0 baseline

Captured on 2026-07-17 before product-code changes.

### Local verification

- Unit tests: 182 passed.
- Coverage: 81.48% statements, 72.49% branches, 82.84% functions, and 81.54% lines.
- Production dependency audit: no vulnerabilities (`npm audit --omit=dev`).
- Full development audit: six moderate advisories in the WebdriverIO Cucumber
  development dependency tree. They originate from Cucumber's transitive
  dependencies and are retained until WebdriverIO provides a compatible update;
  incompatible overrides are not permitted merely to clear the audit output.

The enforced local coverage floor is 80% for statements, lines, and functions,
and 70% for branches. CI generates `coverage/lcov.info` for SonarQube import.

### SonarQube Cloud

- Quality gate: `OK`.
- Lines of code: 5,975.
- Cyclomatic complexity: 1,164.
- Cognitive complexity: 692.
- Duplicated-line density: 0.0%.
- Bugs: 0.
- Vulnerabilities: 0.
- Code smells and violations: 1 pre-existing test-stability finding
  (`typescript:S5973` in the intentional retry fixture).
- Coverage: absent from the server baseline because LCOV was not previously
  imported.

Pull requests from branches in this repository run CI-based SonarQube analysis.
The repository must provide a `SONAR_TOKEN` GitHub Actions secret, and SonarQube
Cloud automatic analysis must be disabled to avoid duplicate analysis. Fork pull
requests intentionally skip the secret-bearing scan and cannot satisfy the
pre-1.0 completion gate until a trusted-branch analysis is run.

## Chunk 1 checkpoint

Captured on 2026-07-17 after the deterministic characterization harness was
implemented. No production source or public package interface changed.

### Behavior coverage

- Public-internet browser dependencies were replaced by ephemeral primary and
  cross-origin fixture servers bound to `127.0.0.1` on OS-assigned ports.
- Core coverage includes navigation, static and animated pages, same-origin and
  cross-origin frames, browser dialogs, viewport changes, multiple tabs, and a
  target that closes itself.
- Existing retention, retry-only, spec-file retry, spec scope, naming, spec
  filters, segmentation, merge, transcode, deferred processing, and concurrency
  behaviors are characterized without production-code changes.
- Additional modes validate expected-failure retention, cross-worker global slot
  contention and cleanup, and original-media preservation after FFmpeg failure.
- Every retained artifact is decoded through FFmpeg and checked for container,
  codec, dimensions, positive duration and frame count, and corruption.
- FFmpeg is mandatory in CI. Only an explicit local
  `WDIO_ALLOW_MISSING_FFMPEG=1` opt-out may skip media assertions.

### Local verification

- Unit tests: 195 passed (13 more than the Chunk 0 baseline).
- Coverage before/after:
  - Statements: 81.48% -> 80.10%.
  - Branches: 72.49% -> 70.77%.
  - Functions: 82.84% -> 83.02%.
  - Lines: 81.54% -> 80.15%.
- The statement/line change comes from adding executable test-harness modules;
  production source is unchanged and all enforced floors remain satisfied.
- Multipart and merged Chrome suites passed with all artifacts decoded.
- Jasmine and Cucumber suites passed with all retained artifacts decoded.
- All 15 advanced modes passed as a harness, including the deliberately failing
  retention run whose non-zero WDIO exit is an expected result.
- Lint, TypeScript 7 typecheck, build, and packed-package inspection passed.

### SonarQube checkpoint

- Server quality gate: `OK`.
- Server measures remain at the main-branch baseline because this checkpoint is
  committed directly to the long-lived release branch without a per-chunk PR:
  5,975 lines, complexity 1,164, cognitive complexity 692, duplication 0.0%,
  0 bugs, 0 vulnerabilities, and 1 pre-existing code smell.
- The sole open issue remains `typescript:S5973` in the intentional retry
  fixture; no issue status was changed.
- The newly installed SonarQube plugin and CLI were not visible to the already
  running Codex task. The Docker analyzer fallback failed with an I/O reactor
  shutdown on the first changed file, so changed-file Sonar analysis must be
  repeated after restarting Codex with the authenticated plugin available.

### Remaining risks

- WDIO v9's live Cucumber hook payload does not currently expose feature tags in
  the shape consumed by the 0.8 filter adapter. The include/exclude tag modes
  deliberately preserve this observed gap for a later intentional fix.
- Chrome auto-handles dialogs during the service's post-command work; the harness
  verifies the resulting state and that recording remains healthy.
- Recommended effort for Chunk 2 (low-risk architecture extraction): medium.

## Chunk 2 checkpoint

Captured on 2026-07-17 after the low-risk architecture extraction. The flat
0.8 configuration API, defaults, package exports, WDIO hook behavior, and media
retention behavior remain unchanged.

### Architecture and behavior

- Service option/profile resolution is now a pure component with an injectable
  platform boundary. Linux and Windows defaults are covered independently.
- Puppeteer page matching is isolated behind a polling component with an
  injectable clock. The existing enumerable page marker and lookup semantics are
  intentionally preserved for the later protocol-correctness chunk.
- FFmpeg process execution is isolated behind spawn and clock contracts,
  including stderr capture, timeout, graceful termination, force-kill, and
  unavailable-binary handling.
- In-process and cross-process recording slot scheduling is owned by a dedicated
  component with injectable filesystem, clock, and process boundaries. Shared
  limits, heartbeat metadata, stale-lock cleanup, waiter wakeup, and idempotent
  release retain their existing behavior.
- Artifact paths are consumed directly from the existing stateless path module,
  and logging now exposes a typed internal logger contract. Forwarding-only
  service methods and their private-method tests were removed.
- `service.ts` was reduced by roughly 1,000 lines and remains the WDIO lifecycle
  and recording coordinator. No new product option or public export was added.
- The user-requested dependency refresh is included: Biome 2.5.4, Cucumber
  13.1.0, and tsx 4.23.1, together with the regenerated lockfile.

### Local verification

- Unit tests: 195 passed across 19 files, preserving the Chunk 1 test count.
- Coverage before/after:
  - Statements: 80.10% -> 80.84%.
  - Branches: 70.77% -> 72.14%.
  - Functions: 83.02% -> 82.12%.
  - Lines: 80.15% -> 80.81%.
- The function percentage reflects additional injectable boundary functions;
  it remains above the 80% gate. The extracted `src/service` components are at
  90.07% statements, 83.30% branches, 85.09% functions, and 90.04% lines.
- Lint, TypeScript 7 typecheck, build, and packed-package inspection passed.
- The production dependency audit reports zero vulnerabilities. The development
  audit still reports six moderate `uuid` advisories in WDIO's nested Cucumber
  dependency. The suggested forced remediation would install an incompatible
  WDIO version and was not applied.
- Multipart and merged Chrome suites passed and decoded 13 and 9 artifacts,
  respectively. Jasmine, Cucumber, and all 15 advanced modes passed, including
  retry/spec-file retry, spec scope, naming, filters, deferred merge,
  cross-worker global contention, intentional-failure retention, and FFmpeg
  failure preservation.
- Generated media preserved the characterized artifact counts, naming,
  containers, codecs, dimensions, positive duration/frame counts, and decodable
  byte streams. Bit-for-bit hashes are intentionally not used because live
  browser capture timestamps and encoded frames are nondeterministic.

### SonarQube checkpoint

- Docker MCP and the authenticated SonarQube CLI can query the project.
- Server quality gate: `OK`; every returned condition passes.
- The only available long-lived analysis is still `master`, so server measures
  remain at the baseline: 5,975 lines, complexity 1,164, cognitive complexity
  692, duplication 0.0%, 0 bugs, 0 vulnerabilities, and 1 code smell. These are
  zero deltas against the Chunk 2 baseline, not a release-branch analysis.
- The sole issue remains the pre-existing `typescript:S5973` finding in the
  intentional retry fixture. No issue status was changed.
- Changed-file analysis could not be completed. The Docker MCP analyzer first
  timed out during initialization and then shut down its I/O reactor. The CLI
  fallback returned `403` because Vortex agentic analysis is not enabled for the
  organization. A final Docker command fallback was blocked by the execution
  environment's source-code egress policy. Per the agreed Sonar-bottleneck rule,
  this does not block the local chunk commit; changed-file analysis remains a
  follow-up when the analyzer is available.
- Server coverage remains absent because this direct-to-release checkpoint does
  not create a per-chunk PR analysis. LCOV is generated locally and remains
  configured for the later trusted CI analysis.

### Remaining risks

- The recording state is still distributed across lifecycle fields in the
  service. Chunk 3 will centralize those transitions and teardown paths; it must
  not be combined with this extraction commit.
- The current marker and capture behavior are deliberately unchanged pending the
  Puppeteer/WDIO protocol chunk.
- Recommended effort for Chunk 3 (recording lifecycle state machine): very high.
  This is the next mandatory pause and effort-recalibration point.
