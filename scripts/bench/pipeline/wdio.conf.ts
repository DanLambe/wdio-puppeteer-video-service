import path from 'node:path'
import MetricsService from './metrics.js'

const runDir = process.env.PIPELINE_RUN_DIR as string
export const config: WebdriverIO.Config = {
  runner: 'local',
  tsConfigPath: '/work/tsconfig.spec.json',
  specs: [path.join(runDir, 'specs/*.spec.ts')],
  maxInstances: Number(process.env.PIPELINE_WORKERS),
  baseUrl: process.env.PIPELINE_URL as string,
  capabilities: [
    {
      browserName: 'chrome',
      webSocketUrl: true,
      'goog:chromeOptions': {
        binary: process.env.CHROME_BINARY as string,
        args: [
          '--headless=new',
          '--no-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--window-size=1920,1080',
          '--force-device-scale-factor=1',
        ],
      },
      'wdio:chromedriverOptions': {
        binary: process.env.CHROMEDRIVER_BINARY as string,
      },
    },
  ],
  logLevel: 'error',
  framework: 'mocha',
  mochaOpts: { timeout: 420_000 },
  waitforTimeout: 10_000,
  connectionRetryCount: 0,
  reporters: ['spec'],
  services: [
    [MetricsService, {}],
    ...(process.env.PIPELINE_VARIANT === 'off'
      ? []
      : [
          [
            path.join(import.meta.dirname, 'instrumented-service.ts'),
            {
              outputDir: path.join(runDir, 'videos'),
              recording: { retain: process.env.PIPELINE_RETAIN },
              capture: { viewport: { width: 1920, height: 1080 } },
              logLevel: 'warn',
              failurePolicy: 'error',
            },
          ] as [string, object],
        ]),
  ],
}
