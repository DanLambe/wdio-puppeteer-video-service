import path from 'node:path'
import { emptyDir } from 'fs-extra'
import WdioPuppeteerVideoReporter from '../src/reporter.js'
import { requireFixtureBaseUrl } from './utils/fixture-environment.js'
import { videoServiceModulePath } from './utils/service-module.js'
import { assertVideoArtifacts } from './utils/video-artifact-assertions.js'

const mergeSegmentsEnabled = ['1', 'true', 'yes'].includes(
  (process.env.WDIO_MERGE_SEGMENTS ?? '').toLowerCase(),
)
const expectVideos = !['0', 'false', 'no'].includes(
  (process.env.WDIO_EXPECT_VIDEOS ?? '1').toLowerCase(),
)
const runMode =
  process.env.WDIO_VIDEO_MODE || (mergeSegmentsEnabled ? 'merge' : 'multipart')
const resultsDir = path.resolve(
  process.env.WDIO_RESULTS_DIR || path.join('tests/results', runMode),
)
const configuredMaxInstances = Number.parseInt(
  process.env.WDIO_MAX_INSTANCES ?? '2',
  10,
)
const maxInstances =
  Number.isFinite(configuredMaxInstances) && configuredMaxInstances > 0
    ? configuredMaxInstances
    : 2
const expectedTestTitles = [
  'should record a simple navigation',
  'should handle iframe switching',
  'should handle a cross-origin iframe',
  'should handle multiple tabs and closing tabs',
  'should tolerate a browser target closing itself',
  'should handle alert, confirm, and prompt dialogs',
  'should handle viewport resizing',
  'should capture a deterministic animation',
  'should record a longer multi-step journey',
]

export const config: WebdriverIO.Config = {
  //
  // ====================
  // Runner Configuration
  // ====================
  runner: 'local',
  baseUrl: requireFixtureBaseUrl(),
  tsConfigPath: './tsconfig.spec.json',
  //
  // ==================
  // Specify Test Files
  // ==================
  specs: ['./specs/**/*.test.ts'],
  // Patterns to exclude.
  exclude: [],
  //
  // ============
  // Capabilities
  // ============
  maxInstances,
  capabilities: [
    {
      browserName: 'chrome',
      'goog:chromeOptions': {
        args: [
          '--headless=new',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--window-size=1280,720',
        ],
      },
    },
  ],
  //
  // ===================
  // Test Configurations
  // ===================
  logLevel: 'error',
  bail: 0,
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  services: [
    [
      videoServiceModulePath,
      {
        outputDir: resultsDir,
        recording: {
          retain: 'all',
        },
        capture: {
          viewport: { width: 1280, height: 720 },
        },
        processing: {
          format: 'mp4',
          timing: 'after-test',
          transcode: {
            enabled: true,
          },
          merge: {
            enabled: mergeSegmentsEnabled,
            deleteSegments: true,
          },
        },
        integrations: { allure: { attach: 'retained' } },
      },
    ],
  ],
  framework: 'mocha',
  reporters: [
    'spec',
    [WdioPuppeteerVideoReporter, { outputDir: resultsDir }],
    [
      'allure',
      {
        outputDir: path.join(resultsDir, 'allure-results'),
        disableWebdriverStepsReporting: true,
        disableWebdriverScreenshotsReporting: true,
      },
    ],
  ],
  mochaOpts: {
    ui: 'bdd',
    timeout: 60000,
  },
  onPrepare: async () => {
    await emptyDir(resultsDir)
  },
  onComplete: async () => {
    await assertVideoArtifacts({
      resultsDir,
      expectedTitles: expectedTestTitles,
      expectVideos,
      mergeSegmentsEnabled,
      fileNameStyle: 'test',
      expectedCodec: 'h264',
      runLabel: runMode,
    })
  },
}
