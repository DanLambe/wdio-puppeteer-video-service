# Changelog

## 2.0.0-rc.1

### Patch Changes

- 46cd18e: The service looks for FFmpeg before a worker's first test, while the browser warms up, instead of inside the first test, and runs `ffmpeg -version` once for each candidate instead of twice. On Windows each run takes about 34 ms. A missing FFmpeg is still reported once, and recording is still disabled for that worker.
- 46cd18e: New option `capture.encoding` (`'live'`, `'auto'` or `'deferred'`, default `'live'`). With `'deferred'`, no encoder runs while a test runs: its frames are written to disk, deleted unencoded if the recording is discarded while still spooled, and encoded per kept segment when the test ends (a large spool or low disk space can start a live encoder sooner). `'auto'` does this only for recordings that may be discarded, such as passing tests under `retain: 'failures'`, and encodes the rest live. Kept recordings produce the same files and manifest entries as live ones. A kept recording that cannot be encoded keeps its frames as a `.frames.mkv` file, with a warning that says how to convert it, and is reported as incomplete; frames a crashed worker left behind are recovered the same way when the run ends. That recovery only touches spool files a worker named, deletes only a spool it can show holds no image, keeps anything it cannot read that way as a `.frames.mkv` file, and does nothing if the spool directory is a link. A deferred recording that spools more than 256 MiB continues as live encoding mid-recording, one that would pass 1 GiB stops and is reported as incomplete, and low free disk space promotes it and then stops it, so a worker's disk use stays bounded. The default, `'live'`, records as before.

  The README's performance tuning section now says when to choose each encoding, with measured numbers.

- 46cd18e: A tab move no longer transcodes the segment it ends. Before, with `format: 'mp4'` and the default `processing.timing: 'after-test'`, the command that moved recording to another tab waited while the previous segment was transcoded, and if the test then passed under `retain: 'failures'` that work was thrown away. Segments are now processed when the test ends, only when the recording is kept; a discarded recording is not transcoded or merged. Kept recordings produce the same files and manifest entries as before.
- 46cd18e: In WebDriver BiDi sessions, recording no longer jumps to a newly opened window because of WebdriverIO's own setup script before the test switches to it. A script now moves recording only to a tab the test holds (from `browser.url()`, `browser.newWindow()`, `browser.browsingContexts()` or a context's `frame()`), a window it has switched to, WebdriverIO's current window, or the recorded tab. A raw `browser.scriptCallFunction()` or `browser.scriptEvaluate()` on a tab known only from `browser.getWindowHandles()` no longer moves recording there; switch to the tab first or use a held context. See the [migration guide](https://github.com/DanLambe/wdio-puppeteer-video-service/blob/master/MIGRATION.md#what-changes-in-webdriver-bidi-sessions).

  An implicit action after `browser.switchToWindow()`, such as `browser.keys()`, no longer moves recording back to the previous tab when a current-window lookup the service started before the switch answers late. Likewise, such a late answer no longer sends recording to a tab that `browser.browsingContextClose()` has closed.

- 46cd18e: A recording now ends on the last change the test made. Before, a change made just before a test ended, or just before recording moved to another tab, was often missing from that video or segment, because Chrome was still capturing its frame when recording stopped. Stopping now waits up to 125 ms for that frame, so each kept stop and each tab move can take up to 125 ms longer; on a page that keeps changing the wait ends after two frames.
- 46cd18e: WebM recordings now carry their length and a seek index. Before, a kept WebM that was not merged or transcoded had neither, so video players and the HTML report could not show how long a recording was, and the scrub bar could not seek to a point in proportion to its length. FFmpeg now writes each recording file itself, which fixes both.

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
