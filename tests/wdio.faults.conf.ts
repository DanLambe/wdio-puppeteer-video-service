import path from 'node:path'
import { emptyDir } from 'fs-extra'
import { requireFixtureBaseUrl } from './utils/fixture-environment.js'

// Injected capture failures in a real browser session. Recording errors are
// rethrown here, so the suite covers the strictest failure policy.
const resultsDir = path.resolve(
  process.env.WDIO_RESULTS_DIR || path.join('tests/results', 'faults'),
)

export const config: WebdriverIO.Config = {
  runner: 'local',
  baseUrl: requireFixtureBaseUrl(),
  tsConfigPath: './tsconfig.spec.json',
  specs: [path.resolve('tests/faults/*.test.ts')],
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
      path.resolve('tests/faults/capture-fault-service.ts'),
      {
        outputDir: resultsDir,
        failurePolicy: 'error',
        recording: { retain: 'all' },
        capture: { viewport: { width: 1280, height: 720 } },
      },
    ],
  ],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 60000 },
  onPrepare: async () => {
    await emptyDir(resultsDir)
  },
}
