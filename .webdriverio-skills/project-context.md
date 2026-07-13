# WebdriverIO project context

Updated 2026-07-12.

This package is a WebdriverIO service that records Puppeteer screencasts and optionally transcodes or merges them with FFmpeg. Tests import the service directly from `src/index.js`.

## Test entrypoints

- `corepack npm run test:unit`: Vitest unit tests.
- `corepack npm run test:e2e:both`: multipart and immediate-merge Mocha E2E modes.
- `corepack npm run test:e2e:frameworks`: Jasmine and Cucumber compatibility.
- `corepack npm run test:e2e:advanced`: retry, spec-level, segmentation, filename, deferred-merge, and spec-filter modes.
- `corepack npm test`: full test matrix.

The main configuration is `tests/wdio.conf.ts`. It uses headless Chrome, disables GPU acceleration, defaults to two workers, and accepts `WDIO_MAX_INSTANCES` for parallelism. The specialized configurations use one worker. All configurations use the spec reporter and local runner.

Video artifacts are written below `tests/results` unless `WDIO_RESULTS_DIR` overrides the location. Completion hooks call `tests/utils/video-artifact-assertions.ts` to validate media artifacts. FFmpeg discovery checks `FFMPEG_PATH` before package and system candidates.

Relevant environment variable names are `FFMPEG_PATH`, `WDIO_ADVANCED_MODE`, `WDIO_EXPECT_VIDEOS`, `WDIO_MAX_INSTANCES`, `WDIO_MERGE_SEGMENTS`, `WDIO_RESULTS_DIR`, and `WDIO_VIDEO_MODE`. Never cache their values.
