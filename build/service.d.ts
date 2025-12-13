import type { Services, Frameworks } from '@wdio/types';
import type { WdioPuppeteerVideoServiceOptions } from './types.js';
/**
 * WebdriverIO Service to record videos using Puppeteer
 */
export default class WdioPuppeteerVideoService implements Services.ServiceInstance {
    private _browser?;
    private _options;
    private _recorder?;
    private _currentSegment;
    private _currentTestTitle;
    private _currentTestFile;
    private _recordedSegments;
    private _isChromium;
    constructor(options: WdioPuppeteerVideoServiceOptions);
    before(_capabilities: unknown, _specs: unknown[], browser: WebdriverIO.Browser): Promise<void>;
    beforeTest(test: Frameworks.Test): Promise<void>;
    afterTest(test: Frameworks.Test, _context: unknown, result: Frameworks.TestResult): Promise<void>;
    afterCommand(commandName: string): Promise<void>;
    private _startRecording;
    private _stopRecording;
    private _deleteSegments;
    private _getSegmentPath;
    private _findPageWithId;
}
