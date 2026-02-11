
# WDIO Puppeteer Video Service

[![npm version](https://img.shields.io/npm/v/wdio-puppeteer-video-service)](https://www.npmjs.com/package/wdio-puppeteer-video-service)
[![npm downloads](https://img.shields.io/npm/dm/wdio-puppeteer-video-service)](https://www.npmjs.com/package/wdio-puppeteer-video-service)
[![License](https://img.shields.io/npm/l/wdio-puppeteer-video-service)](./LICENSE)
[![Publish To NPM](https://github.com/DanLambe/wdio-puppeteer-video-service/actions/workflows/publish.yaml/badge.svg)](https://github.com/DanLambe/wdio-puppeteer-video-service/actions/workflows/publish.yaml)
[![Sonar Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=DanLambe_wdio-puppeteer-video-service&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=DanLambe_wdio-puppeteer-video-service)
[![Sonar Security Rating](https://sonarcloud.io/api/project_badges/measure?project=DanLambe_wdio-puppeteer-video-service&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=DanLambe_wdio-puppeteer-video-service)
[![Sonar Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=DanLambe_wdio-puppeteer-video-service&metric=reliability_rating)](https://sonarcloud.io/summary/new_code?id=DanLambe_wdio-puppeteer-video-service)

A WebdriverIO V9 Service to record videos using Puppeteer (CDP).

> **Beta notice**
> This package is currently in beta (pre-`1.0.0`). APIs, defaults, and behavior may still evolve between minor releases.
> Use in production with caution and pin versions deliberately.

Features:

- **BiDi/CDP Integration**: Uses `browser.getPuppeteer()` for efficient recording.
- **Context-Aware**: Handles multi-tab tests by creating segmented video files.
- **Smart Lifecycle**: Automatically deletes videos for passing tests (configurable).

## Installation

```bash
npm install wdio-puppeteer-video-service
```

## Configuration

Add the service to your `wdio.conf.ts`:

```typescript
import { WdioPuppeteerVideoService } from 'wdio-puppeteer-video-service'

export const config = {
    // ...
    services: [
        [WdioPuppeteerVideoService, {
            outputDir: 'videos',
            saveAllVideos: false, // Save videos only for failed tests
            videoWidth: 1280,
            videoHeight: 720,
            fps: 30,
            // Optional service log level: trace|debug|info|warn|error|silent
            // If omitted, the service inherits WebdriverIO logLevel when available.
            // logLevel: 'info',
            // Optional manual profile for parallel workers:
            // performanceProfile: 'parallel', // 'default' | 'parallel'
            // Optional filename safety controls for long test titles:
            // maxFileNameLength: 180, // defaults: 180 on Windows, 255 elsewhere
            // fileNameStyle: 'test', // 'test' | 'session' | 'sessionFull'
            // fileNameOverflowStrategy: 'truncate', // 'truncate' | 'session'
            outputFormat: 'webm', // or 'mp4'
            // MP4 strategy:
            // mp4Mode: 'auto', // 'auto' | 'direct' | 'transcode' (default: 'auto')
            // In auto mode, direct MP4 is used only when ffmpeg compatibility probes pass.
            // Otherwise the service falls back to WebM capture + H.264 transcode.

            // For explicit H.264 MP4 compatibility, enable transcoding:
            // outputFormat: 'mp4',
            // transcode: { enabled: true, deleteOriginal: true, ffmpegArgs: ['-crf', '28'] },
            // Optional: merge *_partN files into one continuous file per test.
            // mergeSegments: { enabled: true, deleteSegments: true },
            // ffmpegPath: '/usr/bin/ffmpeg',
        }]
    ],
    // ...
}
```

## Prerequisites

- Node.js 24+
- WebdriverIO v9 using `runner: 'local'`
- Chromium-based browser session (Chrome or Edge)
- FFmpeg installed by your environment team:
  - Available as `ffmpeg` on PATH, or
  - Referenced explicitly with `ffmpegPath`, or
  - Exposed via `FFMPEG_PATH`

The service resolves FFmpeg in this order:

1. `ffmpegPath` option
2. `FFMPEG_PATH` environment variable
3. `ffmpeg` on PATH
4. `ffmpeg-static` if it is installed in the project

This package does not install FFmpeg automatically for end users.

## Limitations

- Chromium only: non-Chromium browsers are skipped.
- Window/tab changes create segmented recordings by design (`_partN` files).
- When `mergeSegments.enabled` is true, segments are merged after the test completes.
- Audio is not included in output files.
- `outputFormat: 'mp4'` without `transcode.enabled` can produce VP9-in-MP4 files with limited player compatibility.
- `mp4Mode: 'direct'` may be less reliable on some ffmpeg builds in CI/headless environments.
- Extremely long test titles can still hit OS path limits, so keep `outputDir` reasonably short on Windows.
- Resource-constrained CI runners (shared/low-CPU GitHub Actions agents) can show slower test execution and longer finalize/merge times because browser capture and ffmpeg compete for limited CPU.
- Under heavy parallel load, recording stability depends on available CPU/RAM/IO; this service cannot fully eliminate host-level contention.

## Output

Videos are saved in the `outputDir`.
Default naming convention: `test_title_<session>_<hash>_partN.<webm|mp4>`.
The `<session>` token uses the first WebDriver session GUID segment when present and is capped to 12 characters.

For session-id-only naming, set:

- `fileNameStyle: 'session'` to use a short session token
- `fileNameStyle: 'sessionFull'` to use the full session id token

When session-only naming is used and multiple tests run in the same session, the service appends `_runN` to avoid artifact overwrites.

When `mergeSegments.enabled` is `true`, the service writes a merged file per test:
`test_title_<session>_<hash>.<webm|mp4>`.

If `mergeSegments.deleteSegments` is `true` (default), segment part files are removed after successful merge.
If merge fails, the original parts are kept.

### Filename Safety

For very long test titles/suites, the service enforces filename limits:

- `maxFileNameLength`: basename limit including extension
- `fileNameOverflowStrategy: 'truncate'` (default): keeps a shortened title token
- `fileNameOverflowStrategy: 'session'`: falls back to session/hash-focused names

On Windows, the service also applies a path-aware budget based on `outputDir` to reduce path-length failures.

### Framework Naming

The service is designed to work across WebdriverIO frameworks (Mocha, Jasmine, and Cucumber) by deriving file-name labels from multiple test/scenario fields, then falling back to spec/feature file names when needed.

## FFmpeg Error Handling

If FFmpeg is missing or not executable, the service logs a warning once and skips recording for that worker.
Your WDIO run continues, but no video artifacts are created for that worker until FFmpeg is fixed.

When `outputFormat: 'mp4'` and `mp4Mode: 'auto'`, the service runs a one-time ffmpeg capability probe.
If direct MP4 is not compatible, it automatically falls back to transcode mode to keep recording stable in CI/headless runs.

If a recorder stream closes during teardown (for example, aborted worker shutdown), the service now handles expected write errors (like `EPIPE`) gracefully and prevents repeated stream-failure log spam.

## Logging

Set `logLevel` in service options to control service logs:

- `silent`: no service logs
- `error`: errors only
- `warn`: warnings and errors
- `info`: operational info, warnings, and errors
- `debug` or `trace`: verbose internal flow details

When `logLevel` is omitted, the service uses WebdriverIO `logLevel` when available and falls back to `warn`.

## Parallel Performance Tuning

For CI agents running multiple WDIO workers in parallel, these settings usually provide the best speed/stability balance:

- Use `performanceProfile: 'parallel'` for a manual opt-in baseline (`fps: 24`, `videoWidth: 1280`, `videoHeight: 720`, `outputFormat: webm` when unset).
- On low-tier/shared runners, start with fewer workers (for example `maxInstances: 1-2`) and increase only after artifacts stay stable.
- Prefer `outputFormat: 'webm'` when MP4 output is not strictly required.
- If MP4 is required, use `outputFormat: 'mp4'` with `mp4Mode: 'auto'` (or `transcode.enabled: true`) for safer behavior across ffmpeg builds.
- Lower capture pressure with `fps: 20-24` and `videoWidth/videoHeight: 1280x720`.
- Keep `mergeSegments.enabled: false` during the run if throughput is more important than one-file output (merge can be done as a post-step).
- Set service `logLevel: 'warn'` or `error` on CI to reduce log I/O overhead.

## E2E Mode Verification

The repository includes dedicated scripts to verify both output modes and keep artifacts separated:

- `npm run test:e2e` runs multipart mode only and writes artifacts to `tests/results/multipart`
- `npm run test:e2e:merge` runs merged mode only and writes artifacts to `tests/results/merge`
- `npm run test:e2e:both` runs multipart then merged mode sequentially
- `npm run test:e2e:jasmine` runs a Jasmine WDIO config and validates filename patterns in `tests/results/jasmine`
- `npm run test:e2e:cucumber` runs a Cucumber WDIO config and validates filename patterns in `tests/results/cucumber`
- `npm run test:e2e:frameworks` runs both Jasmine and Cucumber validation sequentially

If FFmpeg is not detected during these local E2E scripts, browser assertions still run and artifact assertions are skipped with a warning.
