# WebdriverIO Project Context

Updated 2026-07-17.

The repository tests its local TypeScript service directly with WDIO v9, headless Chrome, Mocha, Jasmine, and Cucumber. All E2E entry points start ephemeral primary and cross-origin fixture servers on `127.0.0.1`; tests must not depend on public websites.

Use `npm run test:unit` for fast checks, `npm run test:coverage` for LCOV and thresholds, `npm run test:e2e:both` for multipart/merged capture, `npm run test:e2e:frameworks` for Jasmine/Cucumber, and `npm run test:e2e:advanced` for option characterization. Run E2E through these scripts so fixture URLs and the FFmpeg policy are injected into worker processes.

Generated video artifacts are decoded with FFmpeg and checked for container, codec, dimensions, positive duration/frame count, and corruption. CI requires FFmpeg. Only a local run with `WDIO_ALLOW_MISSING_FFMPEG=1` may skip media assertions.

The active reporter is WDIO's `spec` reporter. The service is loaded from `src/index.ts`. E2E results are isolated under `tests/results/<mode>` and cleaned during launcher preparation.

The advanced suite covers retry-only recording, spec-file retries, spec scope, window segmentation, filename styles, immediate and deferred processing, include/exclude spec filters, current Cucumber tag-filter metadata behavior, retention, global recording contention, and FFmpeg failure preservation.
