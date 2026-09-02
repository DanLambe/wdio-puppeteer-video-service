# Support policy

## Supported 1.0 environment

- Node.js 24
- WebdriverIO `>=9.29.1 <10`
- Puppeteer Core `>=24.11.2 <25`
- Chrome through WebDriver BiDi or classic WebDriver with a usable CDP endpoint
- Microsoft Edge classic/CDP smoke coverage
- Mocha, Jasmine, and Cucumber WDIO frameworks
- Ubuntu and Windows GitHub-hosted runners

The Puppeteer floor is the lowest version currently exercised by the package's
release-validation matrix, not a claim that every earlier 24.x API is
incompatible. The floor is widened only after the same package, protocol,
capture-control, and media checks pass on the proposed version.

Finalized merge and transcode artifacts use atomic hard-link publication so an
existing artifact is never overwritten. Keep `outputDir` on a filesystem that
supports hard links; publication failures preserve the source recordings.

The package is ESM-only. The base service does not require reporter peers;
`@wdio/reporter` and `@wdio/allure-reporter` are optional and loaded only by
their corresponding features.

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
