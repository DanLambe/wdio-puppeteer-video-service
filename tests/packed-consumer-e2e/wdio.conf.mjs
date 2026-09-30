import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import VideoReporter from 'wdio-puppeteer-video-service/reporter'

const outputDir = process.env.WDIO_RESULTS_DIR
const classic = process.env.CONSUMER_PROTOCOL === 'classic'

export const config = {
  runner: 'local',
  specs: ['./smoke.spec.mjs'],
  maxInstances: 1,
  baseUrl: process.env.WDIO_FIXTURE_BASE_URL,
  capabilities: [
    {
      browserName: 'chrome',
      ...(classic
        ? { 'wdio:enforceWebDriverClassic': true }
        : { webSocketUrl: true }),
      'goog:chromeOptions': {
        ...(process.env.CHROME_BINARY
          ? { binary: process.env.CHROME_BINARY }
          : {}),
        args: [
          '--headless=new',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--window-size=1280,720',
        ],
      },
      ...(process.env.CHROMEDRIVER_BINARY
        ? {
            'wdio:chromedriverOptions': {
              binary: process.env.CHROMEDRIVER_BINARY,
            },
          }
        : {}),
    },
  ],
  framework: 'mocha',
  mochaOpts: { timeout: 60_000 },
  logLevel: 'error',
  connectionRetryCount: 0,
  // WDIO resolves both the worker service and launcher from the installed package.
  services: [
    [
      'puppeteer-video',
      {
        outputDir,
        recording: { retain: 'all' },
        // An explicit viewport is restored once the screencast starts. With
        // priming off, the static page must still reach the recording.
        capture: {
          viewport: { width: 960, height: 600 },
          fps: 10,
          framePriming: process.env.CONSUMER_FRAME_PRIMING !== 'off',
        },
        integrations: { allure: { attach: 'retained' } },
        failurePolicy: 'error',
      },
    ],
  ],
  reporters: [
    'spec',
    [VideoReporter, { outputDir }],
    [
      'allure',
      {
        outputDir: path.join(outputDir, 'allure-results'),
        disableWebdriverStepsReporting: true,
        disableWebdriverScreenshotsReporting: true,
      },
    ],
  ],
  onPrepare: async () => {
    const entryPoint = await fs.realpath(
      fileURLToPath(import.meta.resolve('wdio-puppeteer-video-service')),
    )
    const installedRoot = await fs.realpath(
      path.join(process.cwd(), 'node_modules/wdio-puppeteer-video-service'),
    )
    assert.ok(
      entryPoint.startsWith(`${installedRoot}${path.sep}`),
      'Service must resolve from the installed tarball',
    )
    await fs.writeFile(
      path.join(outputDir, 'consumer-resolution.json'),
      JSON.stringify({ entryPoint, installedRoot }, null, 2),
    )
  },
}
