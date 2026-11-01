# 2.0 performance decisions and evidence

The measurements behind 2.0's performance claims and decisions, kept with the
harness that produced them. The raw results, recordings and logs are large and
stay outside the repository; the evidence index at the end identifies them by
SHA-256. Every figure is from a Linux Docker container limited to the stated
CPUs and 7 GiB, with Chrome for Testing 154.0.8037.57 headless, FFmpeg 7.0.2,
Node 24.18.0, WebdriverIO 10.1.0 and Puppeteer Core 25.16.0, recording at
1920 × 1080.

## Decisions

- **Single-tab recording costs the same as 1.0.0.** No action.
- **A tab switch adds about 0.8 s to the command that causes it on 2 CPUs
  with 2 workers.** 2.0 accepts and
  documents this cost (README, "Tab Following"). The switch stays synchronous:
  recording stops, the new tab is brought to the front and its capture is primed
  before the command runs, so the command's own effect is filmed.
- **The encoder runs without lookahead** (`-lag-in-frames 0`), which shortened
  every switch and lowered memory.
- **Overlapping the old segment's encoder with the new capture is deferred.**
  Revisit it only if real suites need materially less switching overhead.
- **A proposed 600 ms p50 switching budget was never accepted.** It is not a
  release gate, and no result here passes it.
- **WebdriverIO DevTools 11.0.0 does not replace this service** for per-tab video
  (see below). It is a complementary tracing tool.

## Single-tab overhead: 2.0 against 1.0.0

`npm run bench:pipeline` (standard workload: 4 specs, a static and an animated
page each, 2 s dwell), 5 interleaved pairs per shape, recording off, 1.0.0
(`d4bae0f`) and 2.0 (`73102db`, `src` identical to `a584f0a`). 1.0.0's source
ran on the 2.0 dependency tree, so this isolates the service's own code; it is
not a WebdriverIO 9 → 10 deployment comparison.

| Shape | Suite, 2.0 against 1.0.0 (median pair) | Worker RSS |
| --- | --- | --- |
| 2 CPUs / 2 workers, kept | −2.6% | +1.4% |
| 2 CPUs / 2 workers, discarded | +0.1% | −0.2% |
| 4 CPUs / 4 workers, kept | +2.0% | +0.1% |
| 4 CPUs / 4 workers, discarded | +2.3% | +1.1% |
| 2 CPUs / 4 workers, kept | +0.2% | −1.1% |
| 2 CPUs / 4 workers, discarded | +0.0% | −0.9% |

All 91 runs were valid; a 5-minute soak was flat (minute-median RSS 334 → 322
MiB). After the lookahead change, two smoke pairs (`3cfca95` and `1f166d4`)
were valid and within noise: suite +3.3% and −4.9%, memory +0.1% and −1.0%.

## Tab-switch cost

`npm run bench:pipeline -- --workload switching`: each spec drives two held
WebDriver BiDi tabs through 10 crossings, clicking each crossing's tab first.
Every segment is decoded frame by frame and must show its own tab, open on that
tab's state from before the click, then show the click
(`tests/utils/action-markers.ts`). Latency is each crossing's time less its
pair's median recording-off time.

| Shape | Added per crossing, p50 / p95 / max | Same-tab read | Runs valid |
| --- | --- | --- | --- |
| 2 CPUs / 2 workers | 818 / 996 / 1,261 ms (200 crossings) | +2 ms | 10 of 10 |
| 2 CPUs / 4 workers | 2,145 / 3,460 / 3,932 ms (160 crossings, 4 valid pairs) | +66 ms | 9 of 10 |

Measured on `1f166d4`, which includes the lookahead change, 5 interleaved pairs
per shape. The crossing is a click, so these figures include filming its
repaint. The invalid run at 4 workers failed only the coarse colour check: one
animated segment was under 10% red because Chrome delivered its frames 300–400
ms apart on the oversubscribed host. It showed the right tab and passed the
first-action check. The threshold was left unchanged.

**Where a crossing's time goes** (profile of the same workload, per-crossing
shares, 2 CPUs / 2 workers, before the lookahead change): FFmpeg finishing the
old segment after its input closes, p50 307 ms and a median 38% of the crossing;
frame priming 23%; starting the new screencast 15%. Stopping the screencast,
sealing the last frame, the recorder's own queue (empty at every stop) and
detaching took about 1 ms each.

**The lookahead change** (3 interleaved profile pairs, 120 crossings per side
per shape):

| | 2 CPUs / 2 workers | 2 CPUs / 4 workers |
| --- | --- | --- |
| Switch p50, before → after | 805 → 743 ms | 2,109 → 1,984 ms |
| Switch p95, before → after | 1,021 → 918 ms | 3,093 → 2,664 ms |
| Per-pair p50 change | −7.8%, −7.8%, −7.7% | −12.1%, −13.1%, +3.7% |
| Median container memory saving | 158 MiB | 441 MiB (74–763) |

For the recordings compared, the encoded packets were identical with and
without lookahead. That is a measured result for those inputs and that libvpx,
not a guarantee for every input or version.

## WebdriverIO DevTools 11.0.0, bounded comparison

`@wdio/devtools-service` 11.0.0 at its documented trace-mode options
(`mode: 'trace'`, `traceGranularity: 'test'`, `video` policies), in a separate
image beside the same stack, 2 CPUs / 2 workers, 3 interleaved sets: 33 of 34
planned observations eligible.

| | This service | DevTools 11.0.0 |
| --- | --- | --- |
| Films the tab the test drives | All 144 segments | Only the first tab: 0 frames of the second in all 12 videos |
| Standard suite, videos kept (recording off: 14.3 s) | 19.3 s | 140.9 s |
| Standard suite, only failures kept, all passing | 17.5 s | 21.0 s |
| Click on the filmed tab (off: 33 ms) | 36 ms | 688 ms |
| Click on another tab, no crossing | 25 ms | 5,665 ms |
| Read on the filmed tab (off: 8 ms) | 9 ms | 130 ms |
| Retries and Allure | Kept attempts match their policy; videos attached | Same |

DevTools encodes kept video in its after-test hook, which counts against Mocha's
test timeout: in one set, all four tests passed their bodies and then timed out
at 420 s. It also records traces, network, console and DOM snapshots, which this
service does not; running both together was not tested. The comparison covered
one version, one host shape and its documented options.

## Evidence index

Outside the repository, on the machine that ran them. SHA-256 of each summary:

| Result | File | SHA-256 |
| --- | --- | --- |
| Single-tab overhead | `tests/results/pipeline/v10-standard/comparison.json` | `09876e9c93b87149caa580216ff3788fddfd5dd6030b6a878e285f413f4f30d2` |
| Tab-switch cost (`1f166d4`) | `tests/results/pipeline/rc-switching/comparison.json` | `0ca00038497138d55513d6907a1d94fbaf1ec5860739a23544f62fe7ebea0568` |
| Its environment and snapshot hashes | `tests/results/pipeline/rc-switching/environment.json` | `2be619bf9e6a05b7491693f888c9d0d038a35203050b13ca366565b358f2b983` |
| Switch profile, 2 workers | `claude-v10-switch-profile/out/r6-split/2cpu-2worker/profile-summary.json` | `d0540d088fa5a39d490dc6c7ae7a168189083bac8424bc63a4597e6114b4831e` |
| Switch profile, 4 workers | `claude-v10-switch-profile/out/r6-split/2cpu-4worker/profile-summary.json` | `ddbbbdba5462109180bf21b7be961acc524b45607e5955f8c3cb85d30519463f` |
| DevTools comparison | `claude-v10-devtools/out/r6-matrix/summary.json` | `b0bfb8dec8f17879add58689eb0fb01bff691be6f98226877dbe3e7cf93bc0d8` |
| DevTools comparison inputs (frozen snapshot) | `claude-v10-devtools/out/r6-matrix/snapshot-sha256` | `b376abd0e718f2dd37612bcff16601a5c76486c25bc8d191df5fc7e2c9a1ea46` (content) |
| DevTools click probe | `claude-v10-devtools/out/r6-click/summary.json` | `bbdcc27789e1e53873163d4d101b02d7ef8e07308e2ab16482e59d43f3c9401f` |
