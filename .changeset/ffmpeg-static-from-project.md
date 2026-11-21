---
'wdio-puppeteer-video-service': patch
---

An `ffmpeg-static` installed by your project is now found under package managers that do not hoist it. With npm it was found from this package's own directory, but pnpm with an isolated or global store, and Yarn Plug'n'Play, resolve a package only from a project that declares it, so FFmpeg was reported missing unless `processing.ffmpeg.path` was set. When this package cannot resolve `ffmpeg-static` itself, it now resolves it from the working directory's project.
