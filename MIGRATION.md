# Migrating from 0.8 to 1.0

Version 1.0 intentionally rejects deprecated flat keys. Configuration errors
are raised when the service is constructed, before a browser session starts.

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
  fail acquisition immediately instead of being treated as occupied slots;
  the configured failure policy applies after cleanup.
- Allure requires test scope because the media must be attached while the
  corresponding reporter test remains active.
- The package is ESM-only and requires Node.js 24. Use NodeNext module
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
`@wdio/reporter` when using the reporter export and `@wdio/allure-reporter`
when enabling `integrations.allure`.
