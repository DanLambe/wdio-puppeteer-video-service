# WebdriverIO test health recommendations

## Machine-readable reporting

The suite currently uses only the spec reporter. If CI result ingestion becomes necessary, add a JSON or JUnit reporter as a separate focused change so local output remains readable.

## Failure artifacts

The service-generated video is the primary diagnostic artifact, but the configurations do not explicitly capture a screenshot or HTML snapshot when a test fails. Consider adding failure-only screenshots if video alone proves insufficient; avoid the extra I/O until there is evidence it improves diagnosis.
