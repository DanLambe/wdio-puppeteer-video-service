
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WdioPuppeteerVideoService } from '../build/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
    runner: 'local',
    specs: [
        './specs/**/*.ts'
    ],
    exclude: [],
    maxInstances: 1,
    capabilities: [{
        browserName: 'chrome',
        'goog:chromeOptions': {
            args: ['--headless', '--disable-gpu', '--window-size=1280,720']
        }
    }],
    logLevel: 'info',
    bail: 0,
    baseUrl: 'http://localhost',
    waitforTimeout: 10000,
    connectionRetryTimeout: 120000,
    connectionRetryCount: 3,
    services: [
        [WdioPuppeteerVideoService, {
            outputDir: path.join(__dirname, 'results'),
            saveAllVideos: true, // Save all for verification purposes
            videoWidth: 1280,
            videoHeight: 720
        }]
    ],
    framework: 'mocha',
    reporters: ['spec'],
    mochaOpts: {
        ui: 'bdd',
        timeout: 60000
    },
}
