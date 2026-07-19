import path from 'node:path'
import { emptyDir } from 'fs-extra'
import WdioPuppeteerVideoService from '../src/index.js'
import WdioPuppeteerVideoReporter from '../src/reporter.js'
import { requireFixtureBaseUrl } from './utils/fixture-environment.js'
import { assertVideoArtifacts } from './utils/video-artifact-assertions.js'

const expectVideos = !['0', 'false', 'no'].includes(
  (process.env.WDIO_EXPECT_VIDEOS ?? '1').toLowerCase(),
)
const resultsDir = path.resolve(
  process.env.WDIO_RESULTS_DIR || path.join('tests/results', 'cucumber'),
)
const expectedScenarioTitles = [
  'cucumber style should keep scenario name in video filename',
]
type CucumberFilterMode = 'include-tag' | 'exclude-tag'
const filterMode = process.env.WDIO_CUCUMBER_FILTER_MODE as
  | CucumberFilterMode
  | undefined
// WDIO's live Cucumber hook payload does not expose feature tags in a
// shape the service recognizes. Preserve that behavior until the filter API
// and its framework adapters are intentionally revised in a later chunk.
const expectZeroVideos = filterMode === 'include-tag'

const resolveServiceFilterOptions = (
  mode: CucumberFilterMode | undefined,
): { includeTags?: string[]; excludeTags?: string[] } => {
  if (mode === 'include-tag') {
    return { includeTags: ['@recordable'] }
  }
  if (mode === 'exclude-tag') {
    return { excludeTags: ['@recordable'] }
  }
  return {}
}
const serviceFilterOptions = resolveServiceFilterOptions(filterMode)

export const config: WebdriverIO.Config = {
  runner: 'local',
  baseUrl: requireFixtureBaseUrl(),
  tsConfigPath: './tsconfig.spec.json',
  specs: [path.resolve('tests/cucumber/features/**/*.feature')],
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
          filters: serviceFilterOptions,
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
  framework: 'cucumber',
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
  cucumberOpts: {
    require: [path.resolve('tests/cucumber/steps/**/*.ts')],
    timeout: 60000,
  },
  onPrepare: async () => {
    await emptyDir(resultsDir)
  },
  onComplete: async () => {
    await assertVideoArtifacts({
      resultsDir,
      expectedTitles: expectZeroVideos ? [] : expectedScenarioTitles,
      expectVideos: expectVideos && !expectZeroVideos,
      expectZeroVideos,
      fileNameStyle: 'test',
      expectedCodec: 'h264',
      runLabel: filterMode ? `advanced-${filterMode}` : 'cucumber',
    })
  },
}
