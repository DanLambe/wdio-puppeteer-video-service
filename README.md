
# WDIO Puppeteer Video Service

A WebdriverIO V9 Service to record videos using Puppeteer (CDP).
Features:
- **BiDi/CDP Integration**: Uses `browser.getPuppeteer()` for efficient recording.
- **Context-Aware**: Handles multi-tab tests by creating segmented video files.
- **Smart Lifecycle**: Automatically deletes videos for passing tests (configurable).

## Installation

```bash
npm install wdio-puppeteer-video-service
```

## Configuration

Add the service to your `wdio.conf.ts`:

```typescript
import { WdioPuppeteerVideoService } from 'wdio-puppeteer-video-service';

export const config = {
    // ...
    services: [
        [WdioPuppeteerVideoService, {
            outputDir: 'videos',
            saveAllVideos: false, // Save videos only for failed tests
            videoWidth: 1280,
            videoHeight: 720,
            fps: 30
        }]
    ],
    // ...
}
```

## Requirements

- WebdriverIO V9
- Chromium-based browser (Chrome, Edge)
- **FFmpeg**: Uses `ffmpeg-static` automatically for convenience.
    - If you wish to use a custom FFmpeg, ensure it is in your system PATH and `ffmpeg-static` is not interfering (though currently we prefer static).
    - > **License Note**: This package depends on `ffmpeg-static` which downloads an FFmpeg binary. Ensure you comply with FFmpeg's licensing (LGPL/GPL) for your specific usage.
- Use `runner: 'local'`

## Output
Videos are saved in the `outputDir`.
Naming convention: `test_title_partN.mp4`.
