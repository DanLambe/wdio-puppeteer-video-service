import path from 'node:path'
import { emptyDir } from 'fs-extra'
import WdioPuppeteerVideoService, { type CaptureOptions } from '../src/index.js'
import { requireFixtureBaseUrl } from './utils/fixture-environment.js'
import { probeMediaFile } from './utils/media-probe.js'
import { listVideoArtifacts } from './utils/video-artifact-assertions.js'

const mode = process.env.WDIO_CAPTURE_MODE ?? 'bidi'
const resultsDir = path.resolve(
  process.env.WDIO_RESULTS_DIR ?? path.join('tests/results/capture', mode),
)

const chromeArgs = [
  '--headless=new',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--window-size=1280,720',
]

const createCapabilities = (): WebdriverIO.Capabilities => {
  if (mode === 'edge') {
    return {
      browserName: 'MicrosoftEdge',
      'ms:edgeOptions': { args: chromeArgs },
      'wdio:enforceWebDriverClassic': true,
    }
  }
  if (mode === 'classic') {
    return {
      browserName: 'chrome',
      'goog:chromeOptions': { args: chromeArgs },
      'wdio:enforceWebDriverClassic': true,
    }
  }
  return {
    browserName: 'chrome',
    'goog:chromeOptions': { args: chromeArgs },
    webSocketUrl: true,
  }
}

const capture: CaptureOptions =
  mode === 'controls'
    ? {
        viewport: { width: 960, height: 600 },
        crop: { x: 80, y: 60, width: 800, height: 400 },
        fps: 24,
        quality: 24,
        scale: 0.5,
        speed: 2,
        framePriming: true,
        connectionTimeoutMs: 10_000,
      }
    : {
        viewport: 'current',
        framePriming: true,
        connectionTimeoutMs: 10_000,
      }

export const config: WebdriverIO.Config = {
  runner: 'local',
  baseUrl: requireFixtureBaseUrl(),
  tsConfigPath: './tsconfig.spec.json',
  specs: ['./capture/specs/**/*.spec.ts'],
  maxInstances: 1,
  capabilities: [createCapabilities()],
  logLevel: 'error',
  bail: 0,
  waitforTimeout: 10_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  services: [
    [
      WdioPuppeteerVideoService,
      {
        outputDir: resultsDir,
        recording: { retain: 'all' },
        capture,
        processing: { format: 'webm' },
        logLevel: 'info',
        failurePolicy: 'error',
      },
    ],
  ],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 30_000,
  },
  onPrepare: async () => {
    await emptyDir(resultsDir)
  },
  onComplete: async () => {
    const ffmpegPath = process.env.FFMPEG_PATH?.trim()
    if (!ffmpegPath) {
      throw new Error('FFMPEG_PATH is required for capture media assertions')
    }
    const artifacts = await listVideoArtifacts(resultsDir)
    if (artifacts.length !== 1) {
      throw new Error(
        `Expected one ${mode} capture artifact, found ${artifacts.length.toString()}: ${artifacts.join(', ')}`,
      )
    }
    const artifact = artifacts[0]
    if (!artifact) {
      throw new Error(`The ${mode} capture artifact was not found`)
    }
    const media = await probeMediaFile(
      ffmpegPath,
      path.join(resultsDir, artifact),
    )
    if (media.container !== 'webm' || media.frameCount < 2) {
      throw new Error(
        `Expected a decodable, primed WebM for ${mode}; container=${media.container}, frames=${media.frameCount.toString()}`,
      )
    }
    if (mode === 'controls') {
      if (media.width !== 400 || media.height !== 200) {
        throw new Error(
          `Expected crop then scale dimensions 400x200, received ${media.width.toString()}x${media.height.toString()}`,
        )
      }
      if (media.durationSeconds < 0.4 || media.durationSeconds > 1.3) {
        throw new Error(
          `Expected speed=2 capture duration near half of wall time; received ${media.durationSeconds.toFixed(2)}s`,
        )
      }
    }
    console.log(
      `[wdio:e2e:capture] Verified ${mode}: ${media.width.toString()}x${media.height.toString()}, ${media.durationSeconds.toFixed(2)}s, ${media.frameCount.toString()} frames.`,
    )
  },
}
