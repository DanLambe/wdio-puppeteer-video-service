---
"wdio-puppeteer-video-service": patch
---

Give each same-named Cucumber scenario its own media in the static report.
Because Cucumber emits one reporter outcome per step, the report joined every
step to the first manifest entry whose scenario title matched, so two scenarios
sharing a title — including expanded Scenario Outline rows — both showed the
first scenario's recording and the second capture was reported as unmatched.
The report now assigns a scenario to the next unclaimed matching entry on its
first step and reuses that assignment for the scenario's remaining steps.
