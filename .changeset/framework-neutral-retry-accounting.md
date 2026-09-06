---
"wdio-puppeteer-video-service": patch
---

Account for retries in a framework-neutral way. Cucumber never reports an
attempt number of its own, so a retried scenario previously resolved to attempt
1 again: `recording.retain: 'retries'` could discard the retry recording, and
manifest attempts and static-report joins could be ambiguous. Retry inference
now runs for every `recording.attempts` mode and is keyed on a framework
entity id where one exists, so a Cucumber retry reuses its pickle id while
distinct same-named scenarios stay separate. Mocha keeps using its own
`_currentRetry` value, and the reporter now also reads a scenario retry from
the enclosing suite so manifest and report attempts stay joinable.
