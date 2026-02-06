
# WDIO Puppeteer Video Service

A WebdriverIO V9 Service to record videos using Puppeteer (CDP).
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
            // Optional filename safety controls for long test titles:
            // maxFileNameLength: 180, // defaults: 180 on Windows, 255 elsewhere
            // fileNameOverflowStrategy: 'truncate', // 'truncate' | 'session'
            outputFormat: 'webm', // or 'mp4'
            // For maximum MP4 compatibility (H.264), enable transcoding:
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
- Extremely long test titles can still hit OS path limits, so keep `outputDir` reasonably short on Windows.

## Output
Videos are saved in the `outputDir`.
Default naming convention: `test_title_<session>_<hash>_partN.<webm|mp4>`.
The `<session>` token uses the first WebDriver session GUID segment when present and is capped to 12 characters.

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

## FFmpeg Error Handling

If FFmpeg is missing or not executable, the service logs a warning once and skips recording for that worker.
Your WDIO run continues, but no video artifacts are created for that worker until FFmpeg is fixed.

## Logging

Set `logLevel` in service options to control service logs:
- `silent`: no service logs
- `error`: errors only
- `warn`: warnings and errors
- `info`: operational info, warnings, and errors
- `debug` or `trace`: verbose internal flow details

When `logLevel` is omitted, the service uses WebdriverIO `logLevel` when available and falls back to `warn`.

## E2E Mode Verification
The repository includes dedicated scripts to verify both output modes and keep artifacts separated:

- `npm run test:e2e` runs multipart mode only and writes artifacts to `tests/results/multipart`
- `npm run test:e2e:merge` runs merged mode only and writes artifacts to `tests/results/merge`
- `npm run test:e2e:both` runs multipart then merged mode sequentially

If FFmpeg is not detected during these local E2E scripts, browser assertions still run and artifact assertions are skipped with a warning.
