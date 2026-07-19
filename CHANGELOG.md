# Changelog

This project uses [Changesets](https://github.com/changesets/changesets) for
versioning and release notes.

## 1.0.0-rc.1

- Replaced the flat beta configuration with validated recording, capture,
  processing, concurrency, artifact, and integration groups.
- Added an idempotent recording lifecycle with crash-safe cleanup and separate
  recording/post-processing capacity limits, including recovery after partial
  startup and teardown failures.
- Added Puppeteer 25 viewport, frame-rate, quality, scale, speed, crop, priming,
  and connection-timeout controls.
- Added WDIO v9 Chrome BiDi/classic CDP classification and Edge smoke support.
- Added exclusive artifact reservation, atomic merge/transcode publication,
  source-media preservation, ownership-safe lock recovery, and bounded UTF-8
  FFmpeg diagnostics.
- Added Manifest v1, the offline static HTML reporter, and optional Allure video
  attachments, with consistent cleanup-first failure-policy handling.
- Added deterministic Mocha, Jasmine, and Cucumber media validation with local
  same-origin and cross-origin fixtures.
- Prepared an ESM-only Node.js 24 package with root, manifest, and reporter
  exports.

See [MIGRATION.md](./MIGRATION.md) for the clean-breaking 0.8 migration.
