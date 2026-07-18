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
    width: 1280,
    height: 720,
    fps: 30,
    framePriming: true,
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
  },
  artifacts: {
    naming: {
      style: 'test-full',
      maxLength: 180,
      overflow: 'truncate',
    },
  },
  integrations: {},
  profile: 'ci',
  logLevel: 'warn',
  failurePolicy: 'error',
} satisfies WdioPuppeteerVideoServiceOptions

new WdioPuppeteerVideoService(validOptions)

const removedBetaOption = {
  // @ts-expect-error The 1.0 API does not retain flat beta aliases.
  saveAllVideos: true,
} satisfies WdioPuppeteerVideoServiceOptions

const invalidRecordingScope = {
  recording: {
    // @ts-expect-error Recording scope is test or spec.
    scope: 'suite',
  },
} satisfies WdioPuppeteerVideoServiceOptions

const unknownNestedOption = {
  capture: {
    // @ts-expect-error Unknown grouped keys are rejected.
    bitrate: 5000,
  },
} satisfies WdioPuppeteerVideoServiceOptions

const unavailableIntegration = {
  integrations: {
    // @ts-expect-error Integrations are added only when their implementation ships.
    allure: {},
  },
} satisfies WdioPuppeteerVideoServiceOptions

void removedBetaOption
void invalidRecordingScope
void unknownNestedOption
void unavailableIntegration
