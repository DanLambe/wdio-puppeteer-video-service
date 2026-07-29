# Changelog

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
- Added Puppeteer 25 viewport, frame-rate, quality, scale, speed, crop, priming,
  and connection-timeout controls.
- Added WDIO v9 Chrome BiDi/classic CDP classification and Edge smoke support.
- Added exclusive artifact reservation, atomic merge/transcode publication,
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
