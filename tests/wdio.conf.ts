import path from 'node:path'
import { emptyDir } from 'fs-extra'
import WdioPuppeteerVideoService from '../src/index.js'
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
  'should handle multiple tabs and closing tabs',
  'should handle javascript alerts',
  'should handle viewport resizing',
  'should record a longer multi-step journey',
]

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
      WdioPuppeteerVideoService,
      {
        outputDir: resultsDir,
        saveAllVideos: true,
        videoWidth: 1280,
        videoHeight: 720,
        outputFormat: 'mp4',
        transcode: {
          enabled: true,
        },
        mergeSegments: {
          enabled: mergeSegmentsEnabled,
          deleteSegments: true,
        },
      },
    ],
  ],
  framework: 'mocha',
  reporters: ['spec'],
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
      runLabel: runMode,
    })
  },
}
