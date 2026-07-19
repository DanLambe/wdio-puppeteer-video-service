# WDIO Puppeteer Video Service

[![npm version](https://img.shields.io/npm/v/wdio-puppeteer-video-service)](https://www.npmjs.com/package/wdio-puppeteer-video-service)
[![npm downloads](https://img.shields.io/npm/dm/wdio-puppeteer-video-service)](https://www.npmjs.com/package/wdio-puppeteer-video-service)
[![License](https://img.shields.io/npm/l/wdio-puppeteer-video-service)](./LICENSE)
[![Sonar Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=DanLambe_wdio-puppeteer-video-service&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=DanLambe_wdio-puppeteer-video-service)

A WebdriverIO v9 service that records Chromium sessions through Puppeteer and CDP.

> **1.0 release candidate**
> `1.0.0-rc.1` is the polished release-candidate surface. Install the `next`
> tag while it completes two independent Ubuntu/Windows validation runs. The
> same package becomes `latest` only after those release gates remain clean.

Features:

- Records per test/scenario or per spec.
- Handles multi-tab tests with optional segmented output and FFmpeg merging.
- Supports retry-only capture and independent artifact retention rules.
- Provides cross-worker recording limits and crash-tolerant lifecycle cleanup.
- Uses local, deterministic Mocha, Jasmine, and Cucumber fixtures in CI.
- Produces a crash-tolerant Manifest v1 and an offline static HTML report.
- Optionally attaches retained recordings to the active Allure test.

## Installation

```bash
npm install wdio-puppeteer-video-service
```

To evaluate the release candidate before `1.0.0` is promoted:

```bash
npm install wdio-puppeteer-video-service@next
```

Install `@wdio/allure-reporter` separately when using the optional Allure
integration:

```bash
npm install --save-dev @wdio/allure-reporter
```

## Configuration

Add the service to `wdio.conf.ts`:

```typescript
export const config = {
  services: [
    [
      'puppeteer-video',
      {
        outputDir: 'videos',
        recording: {
          scope: 'test',
          attempts: 'all',
          retain: 'failures',
          windowChanges: 'segment',
          filters: {
            includeSpecs: ['*critical*'],
            excludeTags: ['@no-video'],
          },
        },
        capture: {
          viewport: 'current',
          fps: 30,
          quality: 30,
          scale: 1,
          speed: 1,
          crop: { x: 0, y: 0, width: 1200, height: 700 },
          framePriming: true,
          connectionTimeoutMs: 10000,
        },
        processing: {
          format: 'webm',
          mp4Mode: 'auto',
          timing: 'after-test',
          ffmpeg: {
            path: '/usr/bin/ffmpeg',
            timeoutMs: 0,
          },
          transcode: {
            enabled: false,
            deleteOriginal: true,
          },
          merge: {
            enabled: false,
            deleteSegments: true,
          },
        },
        concurrency: {
          maxRecordingsPerProcess: 0,
          maxRecordingsGlobal: 0,
          startMode: 'blocking',
          startTimeoutMs: 2500,
          maxPostProcessesPerProcess: 0,
          maxPostProcessesGlobal: 0,
          postProcessStartMode: 'blocking',
          postProcessStartTimeoutMs: 2500,
        },
        artifacts: {
          naming: {
            style: 'test',
            overflow: 'truncate',
          },
        },
        integrations: {
          allure: {
            attach: 'failures',
            maxBytes: 25000000,
          },
        },
        profile: 'default',
        logLevel: 'warn',
        failurePolicy: 'warn',
      },
    ],
  ],
}
```

Register the service by package name so WDIO v9 can load both its named launcher
export and its default worker export in the correct processes. Direct imported
class registration is rejected before browser startup because it cannot load
the launcher. Configuration is validated during plugin initialization. Unknown
keys, invalid values, and removed 0.8 aliases throw a path-specific `TypeError`.

## Prerequisites

- Node.js 24+
- WebdriverIO `>=9.29.1 <10` using `runner: 'local'`
- Puppeteer Core `>=25.3.0 <26`
- A Chromium-based browser session (Chrome or Edge)
- FFmpeg supplied by the environment

FFmpeg is resolved in this order:

1. `processing.ffmpeg.path`
2. `FFMPEG_PATH`
3. `ffmpeg` on `PATH`
4. `ffmpeg-static` when installed by the consuming project

This package does not install FFmpeg automatically for end users. Repository
development uses the Node and npm versions declared in `package.json`; run npm
commands through `corepack npm`.

## Option Reference

Top-level options:

- `outputDir` (default `'videos'`): generated artifact directory.
- `profile` (`'default' | 'parallel' | 'ci'`, default `'default'`): grouped preset. Explicit values always win.
- `logLevel` (`'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent'`): inherits WDIO when omitted, with a `'warn'` fallback.
- `failurePolicy` (`'warn' | 'error'`, default `'warn'`): recording, post-processing, manifest, report, and integration failures warn or throw only after applicable cleanup finishes and recoverable source media is preserved.

`recording`:

- `scope` (`'test' | 'spec'`, default `'test'`).
- `attempts` (`'all' | 'retries'`, default `'all'`). WDIO `specFileRetries` worker retries count as retry attempts.
- `retain` (`'failures' | 'retries' | 'all'`, default `'failures'`).
- `windowChanges` (`'segment' | 'ignore'`, default `'segment'`).
- `filters.includeSpecs`, `filters.excludeSpecs`, `filters.includeTags`, and `filters.excludeTags`: case-insensitive patterns supporting `*` wildcards.

`capture`:

- `viewport` (default `'current'`): preserves the browser's current viewport. Use `{ width, height }` to temporarily size capture initialization; the original Puppeteer viewport mode is restored immediately after `page.screencast()` starts.
- `fps` (default `30`; `24` for the `parallel` and `ci` profiles).
- `quality` (default `30`): Puppeteer/FFmpeg constant-rate factor from `0` (best quality) through `63` (smallest output).
- `scale` (default `1`) and `speed` (default `1`): positive finite multipliers passed directly to Puppeteer 25.
- `crop`: optional `{ x, y, width, height }` rectangle. Puppeteer crops before scaling, so an `800x400` crop at `scale: 0.5` produces `400x200` media.
- `framePriming` (default `true`): primes early screencast frames with the viewport warmup.
- `connectionTimeoutMs` (default `10000`): bounds the WDIO `getPuppeteer()` CDP connection.

`processing`:

- `format` (`'webm' | 'mp4'`, default `'webm'`).
- `mp4Mode` (`'auto' | 'direct' | 'transcode'`, default `'auto'`).
- `timing` (`'after-test' | 'after-worker'`, default `'after-test'`).
- `ffmpeg.path` and `ffmpeg.timeoutMs` (default `0`, which disables the timeout).
- `transcode.enabled` (default `false`), `deleteOriginal` (default `true`), and optional `ffmpegArgs`.
- `merge.enabled` (default `false`) and `deleteSegments` (default `true`).

`concurrency`:

- `maxRecordingsPerProcess` (default `0`, unlimited).
- `maxRecordingsGlobal` (default `0`, disabled).
- `startMode` (`'blocking' | 'fast-fail'`, default `'blocking'`).
- `startTimeoutMs` (default `2500`) and optional `lockDir`.
- `maxPostProcessesPerProcess` (default `0`, unlimited).
- `maxPostProcessesGlobal` (default `0`, disabled; the `ci` profile defaults to `1`).
- `postProcessStartMode` (`'blocking' | 'fast-fail'`, default `'blocking'`).
- `postProcessStartTimeoutMs` (default `2500`).

Recording and post-processing use separate in-process and cross-worker slot
pools. Global slots carry heartbeats, but a lease owned by a live process is
never reclaimed solely because its heartbeat expired. Dead owners are reclaimed
immediately; malformed lock files are reclaimed only after an invalid-file grace
period. Capture paths are exclusively reserved, while merge and transcode
outputs are decoded from unique temporary files and atomically published only
after validation. A failed or timed-out operation keeps its source recordings
and removes partial output.

`artifacts.naming`:

- `style` (`'test' | 'test-full' | 'session' | 'session-full'`, default `'test'`).
- `maxLength` (default `180` on Windows and `255` elsewhere).
- `overflow` (`'truncate' | 'session'`, default `'truncate'`).

`integrations.allure`:

- Presence enables lazy loading of the optional `@wdio/allure-reporter` peer.
- `attach` (`'failures' | 'retained'`, default `'failures'`) attaches failed-test media only or every retained recording.
- `maxBytes` optionally skips an individual attachment exceeding the configured byte size.
- Requires `recording.scope: 'test'` and `processing.timing: 'after-test'`. Spec-scoped and after-worker configurations are rejected before browser startup because the final media would not be available while the correct Allure test is active.
- Attachment errors warn by default. `failurePolicy: 'error'` raises them only after recording cleanup finishes.
- Attachments use `video/webm` or `video/mp4` according to the retained file. The normal Allure reporter must also be present in WDIO's `reporters` list.

```typescript
reporters: [
  'spec',
  ['allure', { outputDir: 'allure-results' }],
]
```

Unknown integrations are rejected instead of being silently ignored.

### Recording and Retention Rules

- The defaults record every test/scenario and retain failures only.
- `attempts: 'retries'` skips first-attempt capture.
- `retain: 'retries'` keeps retry-attempt artifacts, including a retry that passes.
- `retain: 'all'` keeps every captured artifact.
- Retry context is passed from the launcher to each worker through WDIO's
  configuration boundary; no retry-state files are written to the artifact
  directory.
- `scope: 'spec'` records one artifact per spec and uses the aggregate spec result.

## Migrating from 0.8 to 1.0

The 1.0 API is clean-breaking. Deprecated aliases are not accepted, including
from JavaScript configuration files. Use this complete mapping:

| 0.8 option | 1.0 option | Notes |
| --- | --- | --- |
| `outputDir` | `outputDir` | Unchanged. |
| `saveAllVideos` | `recording.retain` | `true` becomes `'all'`; `false` becomes `'failures'`. |
| `videoWidth` | `capture.viewport.width` | Set `capture.viewport` to an explicit `{ width, height }` object. |
| `videoHeight` | `capture.viewport.height` | Set `capture.viewport` to an explicit `{ width, height }` object. |
| `fps` | `capture.fps` | |
| `recordOnRetries` | `recording.attempts` and `recording.retain` | For equivalent retry-only behavior, set both to `'retries'`. |
| `specLevelRecording` | `recording.scope` | `true` becomes `'spec'`; `false` becomes `'test'`. |
| `skipViewPortKickoff` | `capture.framePriming` | Values are inverted. |
| `segmentOnWindowSwitch` | `recording.windowChanges` | `true` becomes `'segment'`; `false` becomes `'ignore'`. |
| `maxConcurrentRecordings` | `concurrency.maxRecordingsPerProcess` | |
| `maxGlobalRecordings` | `concurrency.maxRecordingsGlobal` | |
| `recordingStartMode` | `concurrency.startMode` | `'fastFail'` becomes `'fast-fail'`. |
| `recordingStartTimeoutMs` | `concurrency.startTimeoutMs` | |
| `globalRecordingLockDir` | `concurrency.lockDir` | |
| `postProcessMode` | `processing.timing` | `'immediate'` becomes `'after-test'`; `'deferred'` becomes `'after-worker'`. |
| `includeSpecPatterns` | `recording.filters.includeSpecs` | |
| `excludeSpecPatterns` | `recording.filters.excludeSpecs` | |
| `includeTagPatterns` | `recording.filters.includeTags` | |
| `excludeTagPatterns` | `recording.filters.excludeTags` | |
| `performanceProfile` | `profile` | Values are unchanged. |
| `logLevel` | `logLevel` | Unchanged. |
| `maxFileNameLength` | `artifacts.naming.maxLength` | |
| `fileNameOverflowStrategy` | `artifacts.naming.overflow` | |
| `fileNameStyle` | `artifacts.naming.style` | `'testFull'`/`'sessionFull'` become `'test-full'`/`'session-full'`. |
| `ffmpegPath` | `processing.ffmpeg.path` | |
| `ffmpegTimeoutMs` | `processing.ffmpeg.timeoutMs` | |
| `outputFormat` | `processing.format` | |
| `mp4Mode` | `processing.mp4Mode` | |
| `transcode` | `processing.transcode` | Nested fields are unchanged. |
| `mergeSegments` | `processing.merge` | Nested fields are unchanged. |

Before:

```typescript
{
  saveAllVideos: false,
  recordOnRetries: true,
  videoWidth: 1280,
  outputFormat: 'mp4',
  transcode: { enabled: true },
}
```

After:

```typescript
{
  recording: {
    attempts: 'retries',
    retain: 'retries',
  },
  capture: { viewport: { width: 1280, height: 720 } },
  processing: {
    format: 'mp4',
    transcode: { enabled: true },
  },
}
```

## Output and Filename Safety

Videos are written beneath `outputDir`. Test-oriented naming uses
`test_title_<session>_<hash>_partN.<webm|mp4>`. Session-only styles append
`_runN` when needed to prevent overwrites. Successful merging removes the
`_partN` suffix; failed merges preserve their source segments.

The service applies the configured basename limit and a Windows path-aware
budget. Keep `outputDir` reasonably short on Windows.

## Manifest v1

Each launcher creates a privacy-scoped run ID. Workers append crash-tolerant
JSONL journals and `onComplete` atomically aggregates them into
`outputDir/manifest.json`. The manifest includes every observed capture
decision, retry and result, normalized spec and media paths, hashed session
identity, browser/protocol details, timings, dimensions, tool versions, and
post-processing outcomes. Concurrent launchers contribute separate run records
without mixing worker journals.

The dependency-free types and validator are available from the manifest export:

```typescript
import {
  MANIFEST_SCHEMA_VERSION,
  isVideoManifest,
  validateVideoManifest,
  type VideoManifestV1,
} from 'wdio-puppeteer-video-service/manifest'
```

Manifest v1 validators intentionally accept unknown fields: additive optional
fields are minor-compatible. Removing a field, changing required semantics, or
changing an existing enum meaning requires a package major release.
Timestamp fields accept ISO 8601 UTC (`Z`) or numeric-offset values, with or
without fractional seconds.

## Static HTML Reporter

The optional reporter writes one fragment per WDIO worker. After Manifest v1 is
aggregated, the service joins outcomes to captures by run, worker, normalized
spec/test identity, and attempt, then creates `outputDir/video-report.html`.
Skipped tests and tests without retained video remain visible. The report has
status, spec, browser, and retry filters, inline playback, diagnostics, and
error details.

```typescript
import WdioPuppeteerVideoReporter from 'wdio-puppeteer-video-service/reporter'

const outputDir = 'videos'

export const config: WebdriverIO.Config = {
  services: [['puppeteer-video', { outputDir }]],
  reporters: [
    'spec',
    [WdioPuppeteerVideoReporter, { outputDir }],
  ],
}
```

Install `@wdio/reporter` alongside the reporter subpath. It is an optional peer,
so importing the base service does not load reporter code. `reportFileName` may
customize the HTML basename. Directory segments are rejected.

The generated report copies no media and uses encoded relative links to the
existing artifacts. It includes all CSS and JavaScript locally, escapes
test-controlled content, and applies a restrictive Content Security Policy, so
it can be archived or opened offline without a CDN.

## FFmpeg Error Handling

If FFmpeg is missing or not executable, the service warns once and disables
recording for that worker. Failed or timed-out merge/transcode operations retain
source media and remove partial output. Expected teardown stream failures such
as `EPIPE` are contained without repeated log spam.

Direct MP4 compatibility is probed once per worker in `mp4Mode: 'auto'`. An
incompatible build falls back to WebM capture plus H.264 transcode.

## Parallel Performance Tuning

- Use `recording.attempts: 'retries'` and `recording.retain: 'retries'` to reduce capture work.
- Use `recording.scope: 'spec'` when one artifact per spec is sufficient.
- Set `capture.framePriming: false` or `recording.windowChanges: 'ignore'` to reduce capture churn when those tradeoffs are acceptable.
- Limit recorders with `concurrency.maxRecordingsPerProcess` and `maxRecordingsGlobal`.
- Use `concurrency.startMode: 'fast-fail'` to bound contention waits.
- Use `processing.timing: 'after-worker'` to move FFmpeg work out of test hooks.
- The `parallel` profile defaults to 24 fps. The `ci` profile additionally disables frame priming and window segmentation, defers processing, fast-fails recording starts, disables merging unless explicit, and pins service logging to `warn` unless explicit.

## WDIO Protocol Compatibility

WDIO v9 attempts WebDriver BiDi for supported browsers by default. This service
classifies a successful recording session as `bidi+cdp` or `classic+cdp`:
WDIO may issue automation commands through BiDi, while Puppeteer still attaches
to Chrome or Edge through CDP for `page.screencast()`.

Set `'wdio:enforceWebDriverClassic': true` in the browser capability when a
classic-only validation run is required. Both modes use the same CDP capture
path. A session is `unsupported` when no usable CDP endpoint is available.
Diagnostics distinguish multiremote, WDIO browser/component runner, remote
debugging pipes, remote/cloud endpoints without `se:cdp`, non-Chromium
browsers, connection timeout, and generic missing-CDP cases.

## Limitations

- Chromium only; capture requires CDP even when WDIO controls the session through BiDi.
- Audio, Firefox, Safari, Appium/mobile, component runner, multiremote, and cloud sessions without CDP are not supported.
- Chrome sessions started with `--remote-debugging-pipe` are not supported by WDIO `getPuppeteer()`; expose a debugger address instead.
- Window changes are segmented by default.
- VP9-in-MP4 output without transcoding has limited player compatibility.
- Host CPU, RAM, and I/O still determine stability under heavy parallel load.

## Verification

The repository uses an ephemeral two-origin fixture server; E2E runs never
depend on a public website. Fixtures cover static and animated pages, same- and
cross-origin frames, dialogs, viewport changes, tabs, and target closure.

- `npm run test:e2e:both`: multipart and merged Mocha runs.
- `npm run test:e2e:frameworks`: Jasmine and Cucumber runs.
- `npm run test:e2e:capture`: Chrome BiDi/classic, exact crop/scale dimensions, speed duration, viewport restoration, static-page priming, and Edge smoke.
- `npm run test:e2e:advanced`: retry policies, spec scope, window changes, naming, deferred merge, filters, retention, global concurrency, and FFmpeg failure preservation.
- `npm run test:consumer`: builds declarations and compiles an ESM package consumer.
- `npm run test:coverage`: runs the deterministic unit/integration suite with 90% statements, lines, and functions plus 85% branch gates.
- `npm run package:check`: validates the compiled tarball with publint, Are the Types Wrong, and a peer-free ESM consumer install.
- `npm run release:check`: combines lint, typecheck, coverage, package, and validated CycloneDX SBOM gates.

Every generated artifact is decoded with FFmpeg and checked for container,
codec, dimensions, duration, frame count, and corruption. CI fails when FFmpeg
is unavailable. A local browser-only run may explicitly opt out with
`WDIO_ALLOW_MISSING_FFMPEG=1`.

## Release and support documentation

- [0.8 to 1.0 migration](./MIGRATION.md)
- [Support policy](./SUPPORT.md)
- [Troubleshooting](./TROUBLESHOOTING.md)
- [Maintainer release procedure](./RELEASING.md)
- [Changelog](./CHANGELOG.md)
