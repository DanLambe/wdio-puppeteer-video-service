import path from 'node:path'
import { emptyDir } from 'fs-extra'
import WdioPuppeteerVideoReporter from '../src/reporter.js'
import { requireFixtureBaseUrl } from './utils/fixture-environment.js'
import { videoServiceModulePath } from './utils/service-module.js'
import { assertVideoArtifacts } from './utils/video-artifact-assertions.js'

const expectVideos = !['0', 'false', 'no'].includes(
  (process.env.WDIO_EXPECT_VIDEOS ?? '1').toLowerCase(),
)
const resultsDir = path.resolve(
  process.env.WDIO_RESULTS_DIR || path.join('tests/results', 'jasmine'),
)
const expectedTestTitles = [
  'jasmine style should keep test name in video filename',
  'jasmine style should retain an explicitly pending recording',
]

export const config: WebdriverIO.Config = {
  runner: 'local',
  baseUrl: requireFixtureBaseUrl(),
  tsConfigPath: './tsconfig.spec.json',
  specs: ['./jasmine/specs/**/*.spec.ts'],
  maxInstances: 1,
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
  logLevel: 'error',
  bail: 0,
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  services: [
    [
      videoServiceModulePath,
      {
        // Exercise consumer-style relative paths through capture and MP4 processing.
        outputDir: path.relative(process.cwd(), resultsDir),
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
            enabled: false,
          },
        },
        integrations: { allure: { attach: 'retained' } },
      },
    ],
  ],
  framework: 'jasmine',
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
  jasmineOpts: {
    defaultTimeoutInterval: 60000,
  },
  onPrepare: async () => {
    await emptyDir(resultsDir)
  },
  onComplete: async () => {
    await assertVideoArtifacts({
      resultsDir,
      expectedTitles: expectedTestTitles,
      expectVideos,
      fileNameStyle: 'test',
      expectedCodec: 'h264',
      runLabel: 'jasmine',
    })
  },
}
