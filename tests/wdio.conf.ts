import path from 'node:path'
import { emptyDir } from 'fs-extra'
import WdioPuppeteerVideoReporter from '../src/reporter.js'
import { requireFixtureBaseUrl } from './utils/fixture-environment.js'
import { videoServiceModulePath } from './utils/service-module.js'
import { assertVideoArtifacts } from './utils/video-artifact-assertions.js'

const mergeSegmentsEnabled = ['1', 'true', 'yes'].includes(
  (process.env.WDIO_MERGE_SEGMENTS ?? '').toLowerCase(),
)
// Merging keeps the original segments beside the merged file.
const keepMergedSegments = process.env.WDIO_MERGE_KEEP_SEGMENTS === '1'
const expectVideos = !['0', 'false', 'no'].includes(
  (process.env.WDIO_EXPECT_VIDEOS ?? '1').toLowerCase(),
)
// WebDriver BiDi is WDIO 10's default; the Classic suite keeps WDIO's window
// and frame switch commands covered.
const protocol = process.env.WDIO_PROTOCOL === 'classic' ? 'classic' : 'bidi'
// Edge runs the same suites, so its BiDi contexts are checked against the
// pages the service records, not only Chrome's.
const edge = process.env.WDIO_BROWSER === 'edge'
const browserArgs = [
  '--headless=new',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--window-size=1280,720',
]
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
  ...(protocol === 'bidi'
    ? [
        'should follow a held new window',
        'should follow a tab the page opens',
        'should return to its window when a switch to a closed one is rejected',
      ]
    : []),
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
  specs: [
    './specs/**/*.test.ts',
    protocol === 'classic'
      ? './specs-classic/**/*.test.ts'
      : './specs-bidi/**/*.test.ts',
  ],
  // Patterns to exclude.
  exclude: [],
  //
  // ============
  // Capabilities
  // ============
  maxInstances,
  capabilities: [
    {
      ...(protocol === 'classic'
        ? { 'wdio:enforceWebDriverClassic': true }
        : {}),
      ...(edge
        ? {
            browserName: 'MicrosoftEdge',
            'ms:edgeOptions': { args: browserArgs },
          }
        : {
            browserName: 'chrome',
            'goog:chromeOptions': { args: browserArgs },
          }),
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
        // Keep capture/processing warnings visible without WDIO command noise.
        logLevel: 'warn',
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
            deleteSegments: !keepMergedSegments,
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
      segmentPartsKept: keepMergedSegments,
      fileNameStyle: 'test',
      expectedCodec: 'h264',
      runLabel: runMode,
    })
  },
}
