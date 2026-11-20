---
'wdio-puppeteer-video-service': patch
---

In a WebDriver BiDi session, a tab that has closed no longer counts as open. Before, a test that switched to a tab it had already closed, for example to check that the switch fails, ended the recorded tab's segment, spent up to 2 seconds looking for the closed tab, and then started a new segment of the same tab. That switch now leaves the recording alone, as a switch to any other unknown window does.
