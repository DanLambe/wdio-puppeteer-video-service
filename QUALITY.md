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
