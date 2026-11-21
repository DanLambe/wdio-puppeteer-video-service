---
'wdio-puppeteer-video-service': patch
---

Every file name now reaches FFmpeg as an absolute path. 2.0.0-rc.1 did this only for the capture encoder. A recording promoted from deferred to live encoding, and MP4 transcodes, merges and their checks, still passed a relative `outputDir` as given. FFmpeg reads a name that starts with `-` as an option and one that contains a colon, such as `ci:1/videos`, as a protocol, so those steps failed for such a directory.
