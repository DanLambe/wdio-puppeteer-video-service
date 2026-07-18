# WebdriverIO Custom Rules

- Use Node.js 24, TypeScript, and ESM conventions.
- Use strong typing, curly braces for control flow, and no semicolons unless syntax requires them.
- Keep tests deterministic and dependency-light.
- Use the local fixture server; do not introduce public-internet E2E dependencies.
- Prefer user-visible selectors and explicit state waits. Fixed waits are allowed only to retain enough frames for static video characterization and must remain short.
- Run E2E through package scripts so fixture URLs and FFmpeg media validation are configured.
- Do not silently skip media assertions. CI always requires FFmpeg; local opt-out must use `WDIO_ALLOW_MISSING_FFMPEG=1`.
