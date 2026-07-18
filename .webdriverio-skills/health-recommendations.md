# WebdriverIO Health Recommendations

## Machine-readable reporter output

The current E2E configs use only the `spec` reporter. Add a machine-readable reporter or the planned manifest/reporter fragments when the reporting chunks begin so automated diagnostics do not depend on console parsing.

## Failure artifacts

The service records retained video, but the WDIO configs do not yet save an HTML snapshot or screenshot in failure hooks. Add those lightweight diagnostics alongside the planned manifest so failures with missing or corrupt video still have inspectable browser state.

## Cucumber tag metadata

WDIO v9's live Cucumber hook payload currently does not expose feature tags in the shape consumed by the 0.8 filter adapter. The Chunk 1 harness characterizes that gap. Fix the framework adapter deliberately when the grouped filter API is implemented, then invert the include/exclude tag expectations.
