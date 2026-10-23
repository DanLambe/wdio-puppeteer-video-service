# Support policy

## Supported 1.0 environment

- Node.js 24 is the certified runtime. Newer versions are permitted by `engines.node` and supported on a best-effort basis; they are not part of the release certification matrix.
- WebdriverIO `>=9.29.1 <10`. WebdriverIO 10 is not supported yet; see
  [WebdriverIO 10](#webdriverio-10).
- Puppeteer Core `>=24.11.2 <25`
- Chrome through WebDriver BiDi or classic WebDriver with a usable CDP endpoint
- Microsoft Edge classic/CDP smoke coverage
- Mocha, Jasmine, and Cucumber WDIO frameworks
- Ubuntu and Windows GitHub-hosted runners

The Puppeteer floor is intentional. The service records through its own CDP
screencast and FFmpeg pipeline rather than Puppeteer's `page.screencast()`, but
it still depends on Puppeteer Core for the CDP connection, page lookup, and
viewport control that capture is built on. Puppeteer Core 24.11.2 is the lowest
version exercised by the package, protocol, capture-control, and media matrix.
The floor is changed only after the same checks pass on a proposed version.

Finalized merge and transcode artifacts use atomic hard-link publication so an
existing artifact is never overwritten. Keep `outputDir` on a filesystem that
supports hard links; publication failures preserve the source recordings.

The package is ESM-only. The base service does not require reporter peers;
`@wdio/reporter` and `@wdio/allure-reporter` are optional and loaded only by
their corresponding features.

## WebdriverIO 10

1.x supports WebdriverIO 9 only. Its peer ranges stop below 10 on purpose, so
npm reports `ERESOLVE` when a project already uses WebdriverIO 10. Do not bypass
that with `--force`, `--legacy-peer-deps`, or an override. The combination is
untested, and the service could record the wrong page while reporting success.

The blocker is how WebdriverIO 10 selects pages in WebDriver BiDi sessions, which
it uses by default:

- `browser.url()` and `browser.newWindow()` return a browsing context for the
  test to hold, and `newWindow()` no longer switches to the new window.
- `switchWindow()` throws.
- Tests can drive a held browsing context directly, without the window commands
  this service watches to follow the page under test.

An unchanged recorder would then keep filming a page the test has left, and the
video would look valid while showing the wrong tab. Supporting WebdriverIO 10
needs an explicit way to follow the browsing context under test, not just wider
peer ranges.

WebdriverIO 10 support is coming soon. The plan:

- 1.x keeps supporting WebdriverIO 9 and receives fixes under the versioning
  rules below.
- WebdriverIO 10 support is the next planned release. If it can be added beside
  WebdriverIO 9 without changing 1.x options, Manifest v1, or behavior, it ships
  as a 1.x minor release that supports both. If it needs breaking changes, it
  ships as 2.0.0, and 1.x stays available for WebdriverIO 9 projects.
- Until then, keep every WebdriverIO package on 9.

Projects that must move to WebdriverIO 10 before then can evaluate WebdriverIO's
own DevTools service (`@wdio/devtools-service`), which supports WebdriverIO 9
and 10 and records per-test video alongside traces. Its video works differently
from this service's. As of DevTools 11.0.0:

- It records only the first browser tab, so popups and new windows are not
  followed.
- It encodes the saved frames after the test, always as VP8 WebM at a fixed 10
  frames per second and 1 Mb/s. There is no frame-rate, encoder quality, crop,
  or MP4 output setting.
- Its trace and video retention policies are not equivalent to
  `recording.attempts` and `recording.retain`.

Check those differences against the failures you need to diagnose.

## Versioning

- Patch releases contain compatible fixes and documentation improvements.
- Minor releases may add optional configuration or additive Manifest v1 fields.
- Removing manifest fields, changing existing field semantics, or making a
  configuration behavior incompatible requires a major release.
- Release candidates are published under the `next` npm tag. Stable releases
  use `latest` only after two clean release-validation workflow runs for the
  exact commit.

## Issue support

Include Node, WDIO, Puppeteer, browser, protocol classification, FFmpeg version,
framework, configuration, and relevant service diagnostics in bug reports.
Never attach credentials, raw session IDs, or private recordings to a public
issue.

Security reports should use GitHub's private security-advisory flow rather than
a public issue.

## Advisories reported through peers

The package has no runtime dependencies, but `npm audit` lists it as affected
through its WebdriverIO and Puppeteer Core peers. Every supported WDIO 9 and
Puppeteer Core 24 release depends on `@puppeteer/browsers` 2, which unpacks ZIP
archives with `extract-zip` 2.0.1.
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
Puppeteer Core to 25, which this release does not support. Advisories that npm
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
