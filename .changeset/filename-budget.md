---
'wdio-puppeteer-video-service': patch
---

Long test titles no longer break recording on Linux and macOS. A file name there can be at most 255 bytes, and the service fitted only the segment's own name to it, not the longer names it derives from a segment. A title of about 180 characters or more could make the temporary file of an MP4 transcode or a merge too long to create, and on a retry the deferred-encoding spool too, so that segment failed. The part of a name that comes from the test is now at most 179 characters on every platform, so every derived name fits. Names on Windows, whose default `maxLength` is 180, are unchanged.
