---
'wdio-puppeteer-video-service': patch
---

Wait for a just-launched browser to draw before its first test is recorded. On
a fresh machine a browser's first launch can take seconds to draw anything: on
hosted Windows runners the first frame took up to about 12 seconds. Recording
waits only about a second for a first frame, so a short first test could end
before anything was drawn and leave an empty recording. When a Chromium session
starts, the service now waits once, outside every test's timeout, up to 20
seconds for the browser to draw the page, and warns if it does not. Puppeteer's
recorder in earlier releases instead waited without limit for the first frame
inside the first test, where the delay counted toward that test's timeout.
