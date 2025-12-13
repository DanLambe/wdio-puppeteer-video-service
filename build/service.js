import fs from 'node:fs/promises';
import path from 'node:path';
import { PuppeteerScreenRecorder } from 'puppeteer-screen-recorder';
/**
 * WebdriverIO Service to record videos using Puppeteer
 */
export default class WdioPuppeteerVideoService {
    _browser;
    _options;
    _recorder;
    _currentSegment = 0;
    _currentTestTitle = '';
    _currentTestFile = '';
    _recordedSegments = [];
    _isChromium = false;
    constructor(options) {
        this._options = {
            outputDir: 'videos',
            saveAllVideos: false,
            videoWidth: 1280,
            videoHeight: 720,
            fps: 30,
            ...options,
        };
    }
    async before(_capabilities, _specs, browser) {
        this._browser = browser;
        const caps = browser.capabilities;
        const browserName = caps.browserName?.toLowerCase();
        this._isChromium =
            browserName === 'chrome' ||
                browserName === 'microsoftedge' ||
                browserName === 'edge' ||
                caps['goog:chromeOptions'] ||
                caps['ms:edgeOptions'];
        if (!this._isChromium) {
            console.warn('[WdioPuppeteerVideoService] Video recording is only supported on Chromium-based browsers.');
        }
        // Ensure output directory exists
        if (this._options.outputDir) {
            await fs.mkdir(this._options.outputDir, { recursive: true });
        }
    }
    async beforeTest(test) {
        if (!this._isChromium || !this._browser) {
            return;
        }
        this._currentTestTitle = test.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        // Use test.file or parent suite title for uniqueness if needed, but title is usually good enough for local
        // Ideally we'd use a full path or hash. For now, title.
        this._currentSegment = 1;
        this._recordedSegments = [];
        await this._startRecording();
    }
    async afterTest(test, _context, result) {
        if (!this._isChromium || !this._recorder) {
            return;
        }
        await this._stopRecording();
        // Cleanup logic
        const passed = result.passed;
        if (passed && !this._options.saveAllVideos) {
            await this._deleteSegments();
        }
        // Reset state
        this._recorder = undefined;
        this._currentTestTitle = '';
    }
    async afterCommand(commandName) {
        if (!this._isChromium ||
            !this._recorder ||
            !['switchWindow', 'switchToWindow'].includes(commandName)) {
            return;
        }
        // Stop current recording
        await this._stopRecording();
        // Increment segment
        this._currentSegment++;
        // Start new recording on new window
        await this._startRecording();
    }
    async _startRecording() {
        if (!this._browser)
            return;
        try {
            const puppeteerBrowser = (await this._browser.getPuppeteer());
            // Find the active page
            // We tag the current WDIO window with a unique ID
            const targetId = `video-target-${Date.now()}`;
            await this._browser.execute((id) => {
                // @ts-ignore
                window._wdio_video_id = id;
            }, targetId);
            const pages = await puppeteerBrowser.pages();
            const page = await this._findPageWithId(pages, targetId);
            if (!page) {
                console.warn('[WdioPuppeteerVideoService] Could not find puppeteer page match. Recording skipped.');
                return;
            }
            const filePath = this._getSegmentPath();
            this._recorder = new PuppeteerScreenRecorder(page, {
                followNewTab: false, // We handle tabs manually
                fps: this._options.fps,
                ffmpeg_Path: undefined, // relying on default or env? package usually handles it
                videoFrame: {
                    width: this._options.videoWidth,
                    height: this._options.videoHeight,
                },
            });
            await this._recorder.start(filePath);
            this._recordedSegments.push(filePath);
        }
        catch (e) {
            console.error('[WdioPuppeteerVideoService] Failed to start recording:', e);
        }
    }
    async _stopRecording() {
        if (this._recorder) {
            try {
                await this._recorder.stop();
            }
            catch (e) {
                console.warn('[WdioPuppeteerVideoService] Error stopping recorder:', e);
            }
        }
    }
    async _deleteSegments() {
        for (const file of this._recordedSegments) {
            try {
                await fs.unlink(file);
            }
            catch (e) {
                // Ignore if file doesn't exist
            }
        }
        this._recordedSegments = [];
    }
    _getSegmentPath() {
        const filename = `${this._currentTestTitle}_part${this._currentSegment}.mp4`;
        return path.join(this._options.outputDir || 'videos', filename);
    }
    async _findPageWithId(pages, targetId) {
        for (const page of pages) {
            try {
                const id = await page.evaluate(() => {
                    // @ts-ignore
                    return window._wdio_video_id;
                });
                if (id === targetId) {
                    return page;
                }
            }
            catch (e) {
                // access denied or other error on page
            }
        }
        return undefined;
    }
}
//# sourceMappingURL=service.js.map