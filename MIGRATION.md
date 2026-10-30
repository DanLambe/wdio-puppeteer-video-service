# Migrating from 1.x to 2.0

2.0 supports WebdriverIO 10 only. Projects that stay on WebdriverIO 9 keep
using 1.x, which still receives fixes under the `wdio9` npm tag:

```bash
npm install --save-dev wdio-puppeteer-video-service@wdio9
```

## Upgrade the packages together

2.0 requires WebdriverIO `>=10.1.0 <11` and Puppeteer Core `>=25.0.2 <26`.
Move every WebdriverIO package to 10 in the same install, including the
framework, reporters and `expect-webdriverio` 8:

```bash
npm install --save-dev wdio-puppeteer-video-service@2 puppeteer-core@^25.0.2 webdriverio@10 @wdio/cli@10 @wdio/local-runner@10 @wdio/mocha-framework@10
```

While 2.0 is a release candidate, install `wdio-puppeteer-video-service@next`
instead of `@2`.

The service's options are unchanged, so a 1.x configuration works as it is.

## What changes in WebDriver BiDi sessions

WebdriverIO 10 uses WebDriver BiDi by default. There, `browser.url()` and
`browser.newWindow()` return a browsing context the test can hold and drive
directly, `newWindow()` no longer switches to the new tab, and
`switchWindow()` throws. 1.x followed only window commands, so it could keep
filming a tab the test had left.

2.0 records the tab the test is driving:

- A command on a held browsing context, such as `tab.$('#save').click()`,
  moves recording to that tab before the command runs.
- `browser.switchToWindow(handle)` moves recording to that window.
- Element-free Classic actions, such as `browser.keys()`, act on WebdriverIO's
  current window, and recording follows them there.
- A frame is recorded as part of its tab.
- When the recorded tab closes, recording continues on WebdriverIO's current
  window.

Each change of tab starts a new segment, so tests that use several tabs
produce more segments than under 1.x. The recorded tab is brought to the
front, because Chrome does not paint tabs in the background. Each segment's
`tab` field in the manifest says which tab it filmed and why
([Manifest v1](./README.md#manifest-v1)).

Sessions that set `'wdio:enforceWebDriverClassic': true` keep the 1.x
behavior: recording follows `switchWindow`, `switchToWindow`, `newWindow`
and `closeWindow`.

A tab the test drives but the service cannot record is now a gap: the entry
is recorded as `failed` with reason `capture-incomplete`, like an encoder
failure, and `failurePolicy: 'error'` raises it.

## Workers the service cannot record write no manifest entries

The service declares WebdriverIO's static `shouldRun`, so WebdriverIO does not
start it for non-Chromium browsers or multiremote sessions. Those workers log
one warning and write nothing to the manifest. 1.x started the service in them
and wrote a `skipped` entry for each test. Tooling that counted those entries
should count the worker's tests from the test framework instead.

## `parallelMode` is not recorded

With `mochaOpts.parallelMode` or `cucumberOpts.parallelMode`, a spec file's
tests run at the same time. The service records one tab per worker, so it does
not record such workers: it logs one warning, and the manifest lists each test
as `skipped` with the reason. Turn `parallelMode` off for runs you want
recorded.

## Manifest v1 gains optional fields

The manifest stays at version 1, and its new fields are optional:

- each segment's `tab`: `ordinal`, `reason` and a salted `contextHash`;
- `tabs` on a merged file and on `final`, the tabs of its parts in order.

The 1.x validator accepts a 2.0 manifest. Code that reads the manifest needs no
changes unless it wants the tab history.

# Migrating from 0.8 to 1.0

Version 1.0 intentionally rejects deprecated flat keys. Configuration errors
are raised when the service is constructed, before a browser session starts.

1.0 requires WebdriverIO `>=9.29.1 <10` and Puppeteer Core `>=24.11.2 <25`.
Move from 0.8 to 1.x on WebdriverIO 9 first, then to 2.0 and WebdriverIO 10
([Migrating from 1.x to 2.0](#migrating-from-1x-to-20)).

## Option mapping

| 0.8 option | 1.0 option |
| --- | --- |
| `outputDir` | `outputDir` |
| `saveAllVideos` | `recording.retain` |
| `videoWidth`, `videoHeight` | `capture.viewport.width`, `capture.viewport.height` |
| `fps` | `capture.fps` |
| `recordOnRetries` | `recording.attempts` and `recording.retain` |
| `specLevelRecording` | `recording.scope` |
| `skipViewPortKickoff` | `capture.framePriming` with the value inverted |
| `segmentOnWindowSwitch` | `recording.windowChanges` |
| `maxConcurrentRecordings` | `concurrency.maxRecordingsPerProcess` |
| `maxGlobalRecordings` | `concurrency.maxRecordingsGlobal` |
| `recordingStartMode` | `concurrency.startMode` |
| `recordingStartTimeoutMs` | `concurrency.startTimeoutMs` |
| `globalRecordingLockDir` | `concurrency.lockDir` |
| `postProcessMode` | `processing.timing` |
| `includeSpecPatterns`, `excludeSpecPatterns` | `recording.filters.includeSpecs`, `excludeSpecs` |
| `includeTagPatterns`, `excludeTagPatterns` | `recording.filters.includeTags`, `excludeTags` |
| `performanceProfile` | `profile` |
| `logLevel` | `logLevel` |
| `maxFileNameLength` | `artifacts.naming.maxLength` |
| `fileNameOverflowStrategy` | `artifacts.naming.overflow` |
| `fileNameStyle` | `artifacts.naming.style` |
| `ffmpegPath`, `ffmpegTimeoutMs` | `processing.ffmpeg.path`, `timeoutMs` |
| `outputFormat` | `processing.format` |
| `mp4Mode` | `processing.mp4Mode` |
| `transcode` | `processing.transcode` |
| `mergeSegments` | `processing.merge` |

Value conversions are intentional and deprecated aliases are not accepted:

| 0.8 value | 1.0 value |
| --- | --- |
| `saveAllVideos: true` | `recording.retain: 'all'` |
| `saveAllVideos: false` | `recording.retain: 'failures'` |
| `recordOnRetries: true` | `recording.attempts: 'retries'` and usually `recording.retain: 'retries'` |
| `specLevelRecording: true` | `recording.scope: 'spec'` |
| `skipViewPortKickoff: true` | `capture.framePriming: false` |
| `segmentOnWindowSwitch: false` | `recording.windowChanges: 'ignore'` |
| `recordingStartMode: 'fastFail'` | `concurrency.startMode: 'fast-fail'` |
| `postProcessMode: 'immediate'` | `processing.timing: 'after-test'` |
| `postProcessMode: 'deferred'` | `processing.timing: 'after-worker'` |
| `fileNameStyle: 'testFull'` | `artifacts.naming.style: 'test-full'` |
| `fileNameStyle: 'sessionFull'` | `artifacts.naming.style: 'session-full'` |

Equivalent retry-only configuration:

```typescript
{
  recording: {
    attempts: 'retries',
    retain: 'retries',
  },
}
```

## Behavioral changes

- Register the service by package name with
  `services: [['puppeteer-video', options]]`. Direct imported-class
  registration cannot load WDIO's named launcher export and is rejected before
  browser startup.
- Recording defaults to test scope, all attempts, failure retention, and window
  segmentation.
- `failurePolicy` is new in 1.0 and consistently applies `'warn'` or `'error'`
  behavior only after recording, processing, manifest, report, or integration
  cleanup completes.
- `capture.viewport` defaults to `'current'`; an explicit size temporarily
  establishes the recorder canvas and is restored after capture initialization.
  The canvas remains pinned to that start-time size while the test page returns
  to its original viewport mode.
- Optional manifest media dimensions are now read from finalized retained files,
  so they can differ from earlier CSS-based estimates. Pending or unreadable
  artifacts omit dimensions; no Manifest v1 schema change is required.
- `processing.timing: 'after-worker'` defers FFmpeg work and is incompatible
  with Allure attachment integration.
- `concurrency.maxPostProcessesPerProcess` now defaults to `1` and must be a
  positive integer. For after-worker processing, it is the number of deferred
  jobs that can run concurrently in one worker; every FFmpeg operation still
  observes `maxPostProcessesGlobal`.
- Global recording and post-processing limits now coordinate local workers of
  one WDIO invocation. `concurrency.lockDir` is the shared base; each launcher
  creates and cleans its own run subdirectory. Independent invocations no longer
  throttle each other, even when they share `lockDir`. Use CI job limits if those
  invocations must share a host-wide resource budget. Old run directories do not
  consume a new run's capacity.
- Artifact collision resolution stops after 1,000 candidates. Storage failures
  are distinct from occupied slots: healthy-but-busy slots and retryable slot
  errors retain their bounded wait, while all-non-retryable failures abort
  acquisition immediately. The configured failure policy applies after cleanup.
- Allure requires test scope because the media must be attached while the
  corresponding reporter test remains active.
- The package is ESM-only and requires Node.js 24 or newer. Node 24 is certified; newer versions are best-effort. Use NodeNext module
  resolution and import the compiled package exports.

## Imports

```typescript
import type { WdioPuppeteerVideoServiceOptions } from 'wdio-puppeteer-video-service'
import { validateVideoManifest } from 'wdio-puppeteer-video-service/manifest'
import WdioPuppeteerVideoReporter from 'wdio-puppeteer-video-service/reporter'
```

The root default and named worker classes remain available for advanced
programmatic use and testing, but they are not valid values in WDIO's
`services` configuration. String registration is what activates both launcher
and worker halves of the plugin.

The reporter and Allure integration have optional peers. Install
`@wdio/reporter@9` when using the reporter export and `@wdio/allure-reporter@9`
when enabling `integrations.allure`.
