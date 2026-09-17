import path from 'node:path'
import { emptyDir } from 'fs-extra'
import type { CaptureOptions } from '../src/index.js'
import { requireFixtureBaseUrl } from './utils/fixture-environment.js'
import { probeMediaFile } from './utils/media-probe.js'
import { videoServiceModulePath } from './utils/service-module.js'
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
  `--force-device-scale-factor=${mode === 'hidpi' ? '2' : '1'}`,
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

const expectedDimensions: Record<string, { width: number; height: number }> = {
  controls: { width: 400, height: 200 },
  'odd-scale': { width: 400, height: 200 },
  'padded-mp4': { width: 802, height: 402 },
  'filtered-mp4': { width: 320, height: 240 },
}
if (mode === 'low-fps') {
  capture.fps = 1
}
// Continuous animation below 30 FPS: Puppeteer 24's recorder froze it on one
// frame and always encoded at 25 fps.
if (mode === 'animation') {
  capture.fps = 10
}
if (mode === 'unprimed') {
  capture.framePriming = false
  capture.fps = 10
}
if (mode !== 'controls' && expectedDimensions[mode]) {
  capture.viewport = { width: 960, height: 600 }
  capture.crop = { x: 10, y: 20, width: 801, height: 401 }
  capture.scale = mode === 'odd-scale' ? 0.5 : 1
}
const format = mode.endsWith('-mp4') ? 'mp4' : 'webm'

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
      videoServiceModulePath,
      {
        outputDir: resultsDir,
        recording: { retain: 'all' },
        capture,
        processing: {
          format,
          mp4Mode: 'transcode',
          ...(mode === 'filtered-mp4'
            ? { transcode: { ffmpegArgs: ['-vf', 'scale=320:240'] } }
            : {}),
        },
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
    if (media.container !== format || media.frameCount < 2) {
      throw new Error(
        `Expected a decodable, primed ${format} for ${mode}; container=${media.container}, frames=${media.frameCount.toString()}`,
      )
    }
    assertRealTimePlayback(media)
    if (mode === 'animation') {
      const distinct = await probeMediaFile(
        ffmpegPath,
        path.join(resultsDir, artifact),
        { distinctFrames: true },
      )
      if (distinct.frameCount < media.frameCount * 0.5) {
        throw new Error(
          `Expected continuous animation to keep distinct frames; ${distinct.frameCount.toString()} of ${media.frameCount.toString()} frames differ`,
        )
      }
    }
    const expected = expectedDimensions[mode]
    if (
      expected &&
      (media.width !== expected.width || media.height !== expected.height)
    ) {
      throw new Error(
        `Expected ${mode} dimensions ${expected.width}x${expected.height}, received ${media.width}x${media.height}`,
      )
    }
    if (mode === 'controls') {
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

// Encoded frames must follow the configured rate and playback must last about
// as long as the spec kept the page open. Puppeteer 24's recorder encoded every
// video at 25 fps regardless of `capture.fps`, stretching or compressing it.
const assertRealTimePlayback = (media: {
  durationSeconds: number
  frameCount: number
}): void => {
  const speed = capture.speed ?? 1
  // speed retimes frames and FFmpeg keeps the configured output rate.
  const expectedFps = capture.fps ?? 30
  if (media.frameCount >= 15) {
    const effectiveFps = media.frameCount / media.durationSeconds
    if (Math.abs(effectiveFps - expectedFps) > expectedFps * 0.12) {
      throw new Error(
        `Expected ${mode} media near ${expectedFps.toString()} fps; decoded ${effectiveFps.toFixed(1)} fps`,
      )
    }
    return
  }
  // Too few frames to measure a rate: the spec dwells at least 1.5 seconds.
  if (media.durationSeconds * speed < 0.5) {
    throw new Error(
      `Expected ${mode} playback to cover its 1.5 second capture; media plays ${media.durationSeconds.toFixed(2)}s`,
    )
  }
}
