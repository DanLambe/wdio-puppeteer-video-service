import { emptyDir } from 'fs-extra';
import WdioPuppeteerVideoService from './src/index.js';

export const config: WebdriverIO.Config = {
    //
    // ====================
    // Runner Configuration
    // ====================
    runner: 'local',
    tsConfigPath: './tsconfig.spec.json',
    //
    // ==================
    // Specify Test Files
    // ==================
    specs: [
        './tests/specs/**/*.ts'
    ],
    // Patterns to exclude.
    exclude: [
    ],
    //
    // ============
    // Capabilities
    // ============
    maxInstances: 10,
    capabilities: [{
        browserName: 'chrome',
        'goog:chromeOptions': {
            args: ['--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1280,720']
        }
    }],
    //
    // ===================
    // Test Configurations
    // ===================
    logLevel: 'info',
    bail: 0,
    waitforTimeout: 10000,
    connectionRetryTimeout: 120000,
    connectionRetryCount: 3,
    services: [
        [WdioPuppeteerVideoService, {
            outputDir: './tests/results',
            saveAllVideos: true,
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
    onComplete: async () => {
        await emptyDir('./tests/results');
    }
}
