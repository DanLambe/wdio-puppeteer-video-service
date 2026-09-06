---
'wdio-puppeteer-video-service': patch
---

Pin the crop-bound diagnostic against the installed Puppeteer with a real browser
check. The service recognizes Puppeteer's crop errors by their message prefix,
and the unit test asserted against a copy of that wording, so an upstream
rewording would have silently dropped the guidance while the suite stayed green.
The check runs in every capture mode, including against the minimum supported
Puppeteer. No behaviour change.
