---
"wdio-puppeteer-video-service": patch
---

Align Puppeteer Core support with WebdriverIO v9's supported 24.x range while
preserving the existing screencast controls and recording behavior. The tested
floor remains 24.11.2 because Puppeteer Core 24.0.0 does not expose or apply the
`format`, `fps`, and `quality` screencast controls used by the service.
