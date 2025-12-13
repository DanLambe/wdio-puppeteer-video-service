
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Services, Frameworks } from '@wdio/types';
import type { Browser } from 'webdriverio';
import type { Page, Browser as PuppeteerBrowser } from 'puppeteer-core';
import type { WdioPuppeteerVideoServiceOptions } from './types.js';
import { FfmpegRecorder } from './recorder.js';

/**
 * WebdriverIO Service to record videos using Puppeteer and FFmpeg
 */
export default class WdioPuppeteerVideoService implements Services.ServiceInstance {
  private _browser?: Browser;
  private _options: WdioPuppeteerVideoServiceOptions;
  private _recorder?: FfmpegRecorder;
  private _currentSegment = 0;
  private _currentTestTitle = '';
  // private _currentTestFile = ''; // Unused
  private _recordedSegments: string[] = [];
  private _isChromium = false;

  constructor(options: WdioPuppeteerVideoServiceOptions) {
    this._options = {
      outputDir: 'videos',
      saveAllVideos: false,
      videoWidth: 1920,
      videoHeight: 1080,
      fps: 30,
      ...options,
    };
  }

  async before(
    _capabilities: unknown,
    _specs: unknown[],
    browser: WebdriverIO.Browser    
  ): Promise<void> {
    this._browser = browser;
    const caps = browser.capabilities as WebdriverIO.Capabilities;
    const browserName = caps.browserName?.toLowerCase();
    this._isChromium =
      browserName === 'chrome' ||
      browserName === 'microsoftedge' ||
      browserName === 'edge' ||
      !!(caps as any)['goog:chromeOptions'] ||
      !!(caps as any)['ms:edgeOptions'];

    if (!this._isChromium) {
      console.warn(
        '[WdioPuppeteerVideoService] Video recording is only supported on Chromium-based browsers.'
      );
    }

    // Ensure output directory exists
    if (this._options.outputDir) {
      await fs.mkdir(this._options.outputDir, { recursive: true });
    }
  }

  async beforeTest(test: Frameworks.Test): Promise<void> {
    if (!this._isChromium || !this._browser) {
      return;
    }

    this._currentTestTitle = test.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    this._currentSegment = 1;
    this._recordedSegments = [];

    await this._startRecording();
  }

  async afterTest(
    test: Frameworks.Test,
    _context: unknown,
    result: Frameworks.TestResult
  ): Promise<void> {
    if (!this._isChromium) {
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

  async afterCommand(commandName: string): Promise<void> {
    if (
      !this._isChromium ||
      !['switchWindow', 'switchToWindow'].includes(commandName)
    ) {
      return;
    }

    // Stop current recording
    await this._stopRecording();
    // Increment segment
    this._currentSegment++;
    // Start new recording on new window
    await this._startRecording();
  }

  private async _startRecording(): Promise<void> {
    if (!this._browser) return;

    try {
      const puppeteerBrowser = (await this._browser.getPuppeteer()) as unknown as PuppeteerBrowser;
      
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
      
      this._recorder = new FfmpegRecorder(page, {
        fps: this._options.fps || 30,
        width: this._options.videoWidth || 1920,
        height: this._options.videoHeight || 1080
      });

      await this._recorder.start(filePath);
      this._recordedSegments.push(filePath);
    } catch (e) {
      console.error('[WdioPuppeteerVideoService] Failed to start recording:', e);
    }
  }

  private async _stopRecording(): Promise<void> {
    if (this._recorder) {
      try {
        await this._recorder.stop();
      } catch (e) {
        console.warn('[WdioPuppeteerVideoService] Error stopping recorder:', e);
      }
      this._recorder = undefined;
    }
  }

  private async _deleteSegments(): Promise<void> {
    for (const file of this._recordedSegments) {
      try {
        await fs.unlink(file);
      } catch (e) {
        // Ignore if file doesn't exist
      }
    }
    this._recordedSegments = [];
  }

  private _getSegmentPath(): string {
    const filename = `${this._currentTestTitle}_part${this._currentSegment}.mp4`;
    return path.join(this._options.outputDir || 'videos', filename);
  }

  private async _findPageWithId(pages: Page[], targetId: string): Promise<Page | undefined> {
    for (const page of pages) {
      try {
        const id = await page.evaluate(() => {
          // @ts-ignore
          return window._wdio_video_id;
        });
        if (id === targetId) {
          return page;
        }
      } catch (e) {
        // access denied or other error on page
      }
    }
    return undefined;
  }
}
