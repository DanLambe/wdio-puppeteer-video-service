import WdioPuppeteerVideoService, {
  type WdioPuppeteerVideoServiceOptions,
} from '../../src/index.js'

const validOptions = {
  outputDir: 'artifacts/videos',
  recording: {
    scope: 'test',
    attempts: 'all',
    retain: 'failures',
    windowChanges: 'segment',
    filters: {
      includeSpecs: ['*checkout*'],
      excludeTags: ['@no-video'],
    },
  },
  capture: {
    viewport: { width: 1280, height: 720 },
    fps: 30,
    quality: 28,
    scale: 1,
    speed: 1,
    crop: { x: 0, y: 0, width: 1200, height: 700 },
    framePriming: true,
    connectionTimeoutMs: 10_000,
  },
  processing: {
    format: 'mp4',
    mp4Mode: 'auto',
    timing: 'after-test',
    ffmpeg: { timeoutMs: 5000 },
    transcode: { enabled: true },
    merge: { enabled: true },
  },
  concurrency: {
    maxRecordingsPerProcess: 1,
    maxRecordingsGlobal: 2,
    startMode: 'fast-fail',
    startTimeoutMs: 2500,
    maxPostProcessesPerProcess: 1,
    maxPostProcessesGlobal: 1,
    postProcessStartMode: 'blocking',
    postProcessStartTimeoutMs: 2500,
  },
  artifacts: {
    naming: {
      style: 'test-full',
      maxLength: 180,
      overflow: 'truncate',
    },
  },
  integrations: {
    allure: {
      attach: 'retained',
      maxBytes: 25_000_000,
    },
  },
  profile: 'ci',
  logLevel: 'warn',
  failurePolicy: 'error',
} satisfies WdioPuppeteerVideoServiceOptions

export const groupedOptionsService = new WdioPuppeteerVideoService(validOptions)

export const removedBetaOption = {
  // @ts-expect-error The 1.0 API does not retain flat beta aliases.
  saveAllVideos: true,
} satisfies WdioPuppeteerVideoServiceOptions

export const invalidRecordingScope = {
  recording: {
    // @ts-expect-error Recording scope is test or spec.
    scope: 'suite',
  },
} satisfies WdioPuppeteerVideoServiceOptions

export const unknownNestedOption = {
  capture: {
    // @ts-expect-error Unknown grouped keys are rejected.
    bitrate: 5000,
  },
} satisfies WdioPuppeteerVideoServiceOptions

export const invalidAllureMode = {
  integrations: {
    allure: {
      // @ts-expect-error Allure attachments are failures-only or retained.
      attach: 'all',
    },
  },
} satisfies WdioPuppeteerVideoServiceOptions
