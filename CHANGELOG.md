# Changelog

## 2.0.0-rc.0

### Major Changes

- cdaed50: Support WebdriverIO 10. 2.0 requires WebdriverIO `>=10.1.0 <11` and Puppeteer Core `>=25.0.2 <26`; projects on WebdriverIO 9 keep using 1.x (`wdio-puppeteer-video-service@^1`), whose fixes are published under the `wdio9` npm tag. The options are unchanged. See the [migration guide](https://github.com/DanLambe/wdio-puppeteer-video-service/blob/master/MIGRATION.md#migrating-from-1x-to-20).

  - In WebDriver BiDi sessions, recording follows the tab the test drives: a command on a held browsing context from `browser.url()`, `browser.newWindow()` or `browser.browsingContexts()`, a `switchToWindow`, or an element-free action such as `browser.keys()` on WebdriverIO's current window. Recording moves before the command runs, and the recorded tab is brought to the front. Sessions that enforce classic WebDriver keep 1.x behavior.
  - A tab the test drives but the service cannot record leaves the recording `failed` with reason `capture-incomplete`; no other tab is filmed in its place.
  - The VP9 encoder no longer keeps a lookahead buffer, so a recording stops sooner (on a tab switch and at the end of a test) and the encoder holds fewer frames in memory.
  - Manifest v1 segments now record which tab they filmed (`tab`), and merged and final files list their tabs (`tabs`). The HTML report labels multi-tab videos. Manifests still validate with 1.x.
  - Workers on non-Chromium browsers or multiremote sessions no longer start the service, so they write no manifest entries; 1.x wrote a `skipped` entry for each test.
  - WebdriverIO's `parallelMode` is not recorded: the service warns once and lists each test as `skipped` with the reason.

## 1.0.0

The first stable release. 1.0 is a rewrite of the 0.8 service. It records
through its own Chrome DevTools Protocol (CDP) screencast and a streaming FFmpeg
encoder, and adds retry-aware retention, cross-worker limits, a run manifest and
an offline HTML report. Upgrading from 0.8 requires configuration changes; see
the [migration guide](https://github.com/DanLambe/wdio-puppeteer-video-service/blob/master/MIGRATION.md).

### Breaking changes

- Options are grouped into `recording`, `capture`, `processing`, `concurrency`,
  `artifacts`, and `integrations`, and validated when the service starts. Each
  0.8 option is rejected with an error naming its replacement.
- Register the service by package name, `services: [['puppeteer-video', options]]`,
  so WebdriverIO loads both its launcher and worker. Registering the imported
  class is rejected.
- The package is ESM-only and requires Node.js 24 or newer.
- Requires WebdriverIO `>=9.29.1 <10` and Puppeteer Core `>=24.11.2 <25`.
  WebdriverIO 10 support is coming soon; see
  [WebdriverIO 10](https://github.com/DanLambe/wdio-puppeteer-video-service/blob/master/SUPPORT.md#webdriverio-10).

### Recording

- Record each test or Cucumber scenario, or each spec file (`recording.scope`).
- Capture every attempt or only retries (`recording.attempts`), and keep
  failures, retries, or every recording (`recording.retain`). WebdriverIO
  `specFileRetries` count as retries.
- Follow the active tab. Window changes start a new segment, and segments can be
  merged into one video (`recording.windowChanges`, `processing.merge`).
- Include or exclude specs and tags (`recording.filters`).
- Choose a `default`, `parallel`, or `ci` profile for a tuned set of defaults.
  Explicit options always take precedence.

### Video quality and performance

- Videos play back in real time at `capture.fps`. An unchanged page is held as a
  single frame rather than re-encoded, which keeps CPU use and file size low.
- Encoding runs during the test and keeps pace with capture on small CI runners,
  so recordings stop quickly.
- Output is VP9 WebM in 4:2:0 color, which browsers, including Safari, and
  hardware decoders play. MP4 is available directly or by H.264 transcoding
  (`processing.format`, `processing.mp4Mode`, `processing.transcode`).
- Capture controls cover viewport, frame rate, quality, scale, speed, crop, and
  a maximum frame size (`capture.maxWidth`, `capture.maxHeight`). The `ci`
  profile caps frame width at 1280.
- Static pages and freshly launched browsers are recorded from their first frame.

### Reliability

- Memory used by frames waiting for the encoder is bounded. A recording that
  cannot be completed, because the encoder fell behind, failed, or did not stop
  in time, is reported as incomplete (`capture-incomplete`) instead of being
  presented as a full video.
- Recording and post-processing limits apply per worker and across workers
  (`concurrency`). The service cleans up the FFmpeg processes it starts,
  including process trees on Windows, and recovers from interrupted runs.
- Artifacts never overwrite existing files, and source recordings are kept when
  processing fails. `failurePolicy` decides whether failures warn or fail the
  run.
- File names stay within platform path limits (`artifacts.naming`).

### Reports and integrations

- A Manifest v1 file lists every capture decision, attempt, outcome, and
  artifact. Its types and validator are exported from
  `wdio-puppeteer-video-service/manifest`.
- An offline HTML report links each test outcome to its videos, with filters,
  and flags ambiguous or unmatched results rather than guessing. Use the
  `wdio-puppeteer-video-service/reporter` export.
- Attach failed or all retained recordings to Allure (`integrations.allure`).
- Each session is classified as `bidi+cdp`, `classic+cdp`, or unsupported, with
  the reason when recording is not possible.

### Compatibility

- WebdriverIO 9 with Mocha, Jasmine, and Cucumber.
- Chrome through WebDriver BiDi or classic WebDriver, and Microsoft Edge.
- Validated on Ubuntu and Windows, with FFmpeg 4.4 or newer.

### Changes since 1.0.0-rc.6

- Documentation only: WebdriverIO 9 support and the plan for WebdriverIO 10,
  install commands pinned to WebdriverIO 9, and updated guidance for advisories
  reported through WebdriverIO and Puppeteer dependencies.

## Release candidates

Six release candidates, `1.0.0-rc.1` through `1.0.0-rc.6`, were published under
the `next` npm tag before 1.0.0. Their changes are included above. Detailed
notes for each are on the
[GitHub releases page](https://github.com/DanLambe/wdio-puppeteer-video-service/releases).
