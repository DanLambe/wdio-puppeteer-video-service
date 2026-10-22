---
'wdio-puppeteer-video-service': patch
---

Document WebdriverIO 9 as the supported framework for 1.x. WebdriverIO 10 is not supported yet: in its WebDriver BiDi sessions, tests hold browsing contexts instead of switching windows, which the service relies on to follow the page under test. The peer ranges therefore stay below 10, and npm reports a conflict instead of installing an untested combination. The README, support policy, migration guide and troubleshooting explain the conflict, pin WebdriverIO and reporter installs to 9, describe the plan for WebdriverIO 10 support, and replace the release-candidate install instructions with the stable ones. The peer-advisory guidance also covers the `basic-ftp` advisory and corrects what `npm audit fix --force` proposes.
