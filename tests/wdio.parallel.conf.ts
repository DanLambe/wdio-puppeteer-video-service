import path from 'node:path'
import { emptyDir } from 'fs-extra'
import WdioPuppeteerVideoReporter from '../src/reporter.js'
import { requireFixtureBaseUrl } from './utils/fixture-environment.js'
import { videoServiceModulePath } from './utils/service-module.js'

// WebdriverIO's parallelMode runs a spec file's tests at the same time, each in
// its own browser context. The service declines to record such runs; this
// suite checks that it says so instead of filming the wrong test.
const framework =
  process.env.WDIO_PARALLEL_FRAMEWORK === 'cucumber' ? 'cucumber' : 'mocha'
const parallelMode =
  process.env.WDIO_PARALLEL_MODE === 'userContexts'
    ? 'userContexts'
    : 'contexts'
const scope = process.env.WDIO_PARALLEL_SCOPE === 'spec' ? 'spec' : 'test'
const resultsDir = path.resolve(
  process.env.WDIO_RESULTS_DIR ||
    path.join('tests/results', `parallel-${framework}`),
)

export const config: WebdriverIO.Config = {
  runner: 'local',
  baseUrl: requireFixtureBaseUrl(),
  tsConfigPath: './tsconfig.spec.json',
  specs: [
    path.resolve(
      framework === 'cucumber'
        ? 'tests/parallel/parallel-mode.feature'
        : 'tests/parallel/parallel-mode.test.ts',
    ),
  ],
  maxInstances: 1,
  capabilities: [
    {
      browserName: 'chrome',
      // parallelMode needs WDIO's BiDi command implementations.
      'wdio:experimentalBiDiCommands': true,
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
        outputDir: resultsDir,
        recording: { retain: 'all', scope },
        capture: { viewport: { width: 1280, height: 720 } },
      },
    ],
  ],
  framework,
  reporters: ['spec', [WdioPuppeteerVideoReporter, { outputDir: resultsDir }]],
  mochaOpts: {
    ui: 'bdd',
    timeout: 60000,
    parallelMode,
  },
  cucumberOpts: {
    require: [path.resolve('tests/parallel/parallel-mode.steps.ts')],
    timeout: 60000,
    parallelMode,
  },
  onPrepare: async () => {
    await emptyDir(resultsDir)
  },
}
