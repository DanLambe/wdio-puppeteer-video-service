# WDIO Puppeteer Video Service

[![npm version](https://img.shields.io/npm/v/wdio-puppeteer-video-service)](https://www.npmjs.com/package/wdio-puppeteer-video-service)
[![npm downloads](https://img.shields.io/npm/dm/wdio-puppeteer-video-service)](https://www.npmjs.com/package/wdio-puppeteer-video-service)
[![License](https://img.shields.io/npm/l/wdio-puppeteer-video-service)](./LICENSE)
[![Sonar Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=DanLambe_wdio-puppeteer-video-service&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=DanLambe_wdio-puppeteer-video-service)

A WebdriverIO v9 service that records Chromium sessions through Puppeteer and CDP.

> **Pre-1.0 notice**
> The `1.0.0` configuration API is now represented on the release branch, but
> the package remains prerelease until the rest of the 1.0 feature and release
> gates are complete.

Features:

- Records per test/scenario or per spec.
- Handles multi-tab tests with optional segmented output and FFmpeg merging.
- Supports retry-only capture and independent artifact retention rules.
- Provides cross-worker recording limits and crash-tolerant lifecycle cleanup.
- Uses local, deterministic Mocha, Jasmine, and Cucumber fixtures in CI.

## Installation

```bash
npm install wdio-puppeteer-video-service
```

## Configuration

Add the service to `wdio.conf.ts`:

```typescript
import { WdioPuppeteerVideoService } from 'wdio-puppeteer-video-service'

export const config = {
  services: [
    [
      WdioPuppeteerVideoService,
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
          width: 1280,
          height: 720,
          fps: 30,
          framePriming: true,
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
        },
        artifacts: {
          naming: {
            style: 'test',
            overflow: 'truncate',
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

Configuration is validated when the service is constructed, before a browser
session starts. Unknown keys, invalid values, and removed 0.8 aliases throw a
path-specific `TypeError`.

## Prerequisites

- Node.js 24+
- WebdriverIO v9 using `runner: 'local'`
- Puppeteer Core 25.3+
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
- `failurePolicy` (`'warn' | 'error'`, default `'warn'`): reserved for consistent cleanup-first failure handling in the 1.0 processing work.

`recording`:

- `scope` (`'test' | 'spec'`, default `'test'`).
- `attempts` (`'all' | 'retries'`, default `'all'`). WDIO `specFileRetries` worker retries count as retry attempts.
- `retain` (`'failures' | 'retries' | 'all'`, default `'failures'`).
- `windowChanges` (`'segment' | 'ignore'`, default `'segment'`).
- `filters.includeSpecs`, `filters.excludeSpecs`, `filters.includeTags`, and `filters.excludeTags`: case-insensitive patterns supporting `*` wildcards.

`capture`:

- `width` (default `1280`), `height` (default `720`), and `fps` (default `30`).
- `framePriming` (default `true`): primes early screencast frames with the viewport warmup.

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

`artifacts.naming`:

- `style` (`'test' | 'test-full' | 'session' | 'session-full'`, default `'test'`).
- `maxLength` (default `180` on Windows and `255` elsewhere).
- `overflow` (`'truncate' | 'session'`, default `'truncate'`).

`integrations` is intentionally empty until an integration is implemented. An
unknown integration is rejected instead of being silently ignored.

### Recording and Retention Rules

- The defaults record every test/scenario and retain failures only.
- `attempts: 'retries'` skips first-attempt capture.
- `retain: 'retries'` keeps retry-attempt artifacts, including a retry that passes.
- `retain: 'all'` keeps every captured artifact.
- Retry state is stored under `<outputDir>/.wdio-video-retry-state` and cleaned by launcher hooks.
- `scope: 'spec'` records one artifact per spec and uses the aggregate spec result.

## Migrating from 0.8 to 1.0

The 1.0 API is clean-breaking. Deprecated aliases are not accepted, including
from JavaScript configuration files. Use this complete mapping:

| 0.8 option | 1.0 option | Notes |
| --- | --- | --- |
| `outputDir` | `outputDir` | Unchanged. |
| `saveAllVideos` | `recording.retain` | `true` becomes `'all'`; `false` becomes `'failures'`. |
| `videoWidth` | `capture.width` | |
| `videoHeight` | `capture.height` | |
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
  capture: { width: 1280 },
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

## Limitations

- Chromium only; capture requires CDP even when WDIO controls the session through BiDi.
- Audio, Firefox, Safari, Appium/mobile, component runner, multiremote, and cloud sessions without CDP are not supported.
- Window changes are segmented by default.
- VP9-in-MP4 output without transcoding has limited player compatibility.
- Host CPU, RAM, and I/O still determine stability under heavy parallel load.

## Verification

The repository uses an ephemeral two-origin fixture server; E2E runs never
depend on a public website. Fixtures cover static and animated pages, same- and
cross-origin frames, dialogs, viewport changes, tabs, and target closure.

- `npm run test:e2e:both`: multipart and merged Mocha runs.
- `npm run test:e2e:frameworks`: Jasmine and Cucumber runs.
- `npm run test:e2e:advanced`: retry policies, spec scope, window changes, naming, deferred merge, filters, retention, global concurrency, and FFmpeg failure preservation.
- `npm run test:consumer`: builds declarations and compiles an ESM package consumer.

Every generated artifact is decoded with FFmpeg and checked for container,
codec, dimensions, duration, frame count, and corruption. CI fails when FFmpeg
is unavailable. A local browser-only run may explicitly opt out with
`WDIO_ALLOW_MISSING_FFMPEG=1`.
