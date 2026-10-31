# Support policy

## Supported 2.x environment

- Node.js 24 is the certified runtime. Newer versions are permitted by `engines.node` and supported on a best-effort basis; they are not part of the release certification matrix.
- WebdriverIO `>=10.1.0 <11`. For WebdriverIO 9, use 1.x; see
  [WebdriverIO 9](#webdriverio-9).
- Puppeteer Core `>=25.0.2 <26`
- Chrome through WebDriver BiDi or classic WebDriver with a usable CDP endpoint
- Microsoft Edge through WebDriver BiDi and classic WebDriver
- Mocha, Jasmine, and Cucumber WDIO frameworks
- Ubuntu and Windows GitHub-hosted runners

The Puppeteer floor is intentional. The service records through its own CDP
screencast and FFmpeg pipeline rather than Puppeteer's `page.screencast()`, but
it still depends on Puppeteer Core for the CDP connection, page lookup, and
viewport control that capture is built on. Puppeteer Core 25.0.2, the first 25.x
release on npm, is the lowest version exercised by the package, protocol,
capture-control, and media matrix. The floor is changed only after the same
checks pass on a proposed version.

Finalized merge and transcode artifacts use atomic hard-link publication so an
existing artifact is never overwritten. Keep `outputDir` on a filesystem that
supports hard links; publication failures preserve the source recordings.

The package is ESM-only. The base service does not require reporter peers;
`@wdio/reporter` and `@wdio/allure-reporter` are optional and loaded only by
their corresponding features.

### Tab following and WebdriverIO internals

In WebDriver BiDi sessions the service records the tab the test drives
([README](./README.md#tab-following)). Finding that tab's page relies on two
WebdriverIO and Chromium details that are not public API: a top-level browsing
context's id equals its CDP target id, and WebdriverIO keeps track of its
current window. If a context's id is not a target id, the service finds its page
by injecting a short-lived marker into that context instead. Each pull request
installs the newest WebdriverIO 10 and Puppeteer 25 and checks which tab each
recorded segment shows, so a WebdriverIO release that changes either detail
fails the next pull request's checks.

The id mapping was last measured for 2.0.0 with WebdriverIO 10.1.0, Puppeteer
Core 25.16.0, Chrome 156.0.8078.80 and Edge 156.0.4314.50 on Windows. The
initial tab, plus 20 each of `newWindow()` tabs, `_blank` popups and separate
`window.open()` windows, made 61 contexts per browser. Every one was found by
target id, and the marker fallback was never used. Pull request checks cover
Chrome only; release validation adds Edge.

These are not supported:

- WebdriverIO's `parallelMode`. Workers that use it are not recorded, and the
  manifest says why.
- Commands on different tabs at the same time, such as
  `Promise.all([a.$('#x').click(), b.$('#y').click()])`. Recording follows the
  most recent one.
- Commands sent to a tab in the background, by another service or a promise
  the test did not await, while the test works in a different tab. Recording
  cannot tell who sent a command, so it moves to that tab.

## WebdriverIO 10

2.x is the WebdriverIO 10 line; see
[Supported 2.x environment](#supported-2x-environment). The 1.0.0 changelog
links here from when WebdriverIO 10 support was still planned.
[Migrating from 1.x to 2.0](./MIGRATION.md#migrating-from-1x-to-20) explains
what changed and why it needed a major release.

## WebdriverIO 9

1.x supports WebdriverIO 9 (`>=9.29.1 <10`) with Puppeteer Core
`>=24.11.2 <25`. It receives compatible fixes under the versioning rules below,
published under the `wdio9` npm tag; new features land in 2.x. Install it with a
1.x range, which also picks up those fixes:

```bash
npm install --save-dev wdio-puppeteer-video-service@^1
```

2.x refuses to install beside WebdriverIO 9 on purpose, and 1.x refuses
WebdriverIO 10. Do not bypass either with `--force`, `--legacy-peer-deps`, or an
override: 1.x does not follow the tabs a WebdriverIO 10 test drives, so it could
film a tab the test has left while reporting success.
[Migrating from 1.x to 2.0](./MIGRATION.md#migrating-from-1x-to-20) lists what
changes.

## Versioning

- Patch releases contain compatible fixes and documentation improvements.
- Minor releases may add optional configuration or additive Manifest v1 fields.
- Removing manifest fields, changing existing field semantics, or making a
  configuration behavior incompatible requires a major release.
- Release candidates are published under the `next` npm tag. Stable releases
  use `latest` only after two clean release-validation workflow runs for the
  exact commit.
- 1.x releases are published under the `wdio9` tag and never move `latest`.

## Issue support

Include Node, WDIO, Puppeteer, browser, protocol classification, FFmpeg version,
framework, configuration, and relevant service diagnostics in bug reports.
Never attach credentials, raw session IDs, or private recordings to a public
issue.

Security reports should use GitHub's private security-advisory flow rather than
a public issue.

## Advisories reported through peers

The package has no runtime dependencies, so `npm audit` can only list it as
affected through its WebdriverIO and Puppeteer Core peers. WebdriverIO 10 and
Puppeteer Core 25 use `@puppeteer/browsers` 3, which no longer depends on
`extract-zip` or `basic-ftp`; with 2.x's peers, `npm audit` reports neither of
the advisories below.

### 1.x: advisories through WebdriverIO 9 peers

Every WDIO 9 and Puppeteer Core 24 release that 1.x supports depends on
`@puppeteer/browsers` 2, which unpacks ZIP archives with `extract-zip` 2.0.1.
[GHSA-jmr9-qjv8-65gv](https://github.com/advisories/GHSA-jmr9-qjv8-65gv) and
[GHSA-7pqw-9j4j-h8q3](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3)
describe how a crafted archive can write files outside its extraction
directory. No patched `extract-zip` exists.

The same package reaches `basic-ftp` 5 through its proxy support.
[GHSA-c475-qrg2-pj4r](https://github.com/advisories/GHSA-c475-qrg2-pj4r) is a
denial of service when parsing FTP directory listings, fixed only in
`basic-ftp` 6.2.1, outside the range those releases accept. It is reached only
when a browser or driver download goes through a proxy configured with a PAC
file served over FTP (`pac+ftp://`).

Do not clear these reports with `npm audit fix --force`. It proposes
incompatible changes, such as downgrading this service to 0.8.0 or moving
Puppeteer Core to 25, which 1.x does not support. Moving to WebdriverIO 10 and
2.x removes them. Advisories that npm
reports only through a WDIO framework adapter, such as `braces` through Mocha,
belong to that framework and do not involve this service.

The service never downloads or unpacks archives; it attaches to the browser
WDIO has already started. `extract-zip` runs when WDIO prepares a local Chrome
session and has to fetch Chrome for Testing or ChromeDriver:

- Chrome is fetched when `browserVersion` is set, or when
  `goog:chromeOptions.binary` is unset and no installed Chrome is found.
- ChromeDriver is fetched unless `wdio:chromedriverOptions.binary` or
  `CHROMEDRIVER_PATH` names a driver.
- Either one is skipped when a matching build is already in WDIO's cache
  directory.
- Sessions on an existing WebDriver server, configured with `hostname`,
  `port`, or cloud `user` and `key`, skip this setup. Edge's driver download
  uses a different extractor.

Archives come from Google's Chrome for Testing storage over HTTPS, or from
`CHROMEDRIVER_CDNURL` when it is set. Anyone who could replace such an archive
could also replace the browser or driver that WDIO then runs, so the advisories
do not widen what you already trust in the download source. The cache is
different: WDIO unpacks an archive it finds there without downloading it, and
runs a driver it finds there.

To reduce exposure:

- Install Chrome and ChromeDriver from a trusted source, such as your runner
  image, and set `goog:chromeOptions.binary` and
  `wdio:chromedriverOptions.binary` (or `CHROMEDRIVER_PATH`). Nothing is then
  downloaded or unpacked.
- Set `CHROMEDRIVER_CDNURL` only to a mirror you trust.
- Keep the cache directory writable only by the test user. WDIO uses
  `wdio:chromedriverOptions.cacheDir`, the `cacheDir` option or
  `WEBDRIVER_CACHE_DIR`, and otherwise the system temporary directory.
