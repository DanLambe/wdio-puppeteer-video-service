import path from 'node:path'
import { emptyDir } from 'fs-extra'
import WdioPuppeteerVideoService from '../src/index.js'
import { requireFixtureBaseUrl } from './utils/fixture-environment.js'
import { assertVideoArtifacts } from './utils/video-artifact-assertions.js'

const expectVideos = !['0', 'false', 'no'].includes(
  (process.env.WDIO_EXPECT_VIDEOS ?? '1').toLowerCase(),
)
const resultsDir = path.resolve(
  process.env.WDIO_RESULTS_DIR || path.join('tests/results', 'jasmine'),
)
const expectedTestTitles = [
  'jasmine style should keep test name in video filename',
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
      WdioPuppeteerVideoService,
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
          transcode: {
            enabled: true,
          },
          merge: {
            enabled: false,
          },
        },
      },
    ],
  ],
  framework: 'jasmine',
  reporters: ['spec'],
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
