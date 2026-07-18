import WdioPuppeteerVideoService, {
  type CaptureOptions,
  type RecordingOptions,
  type WdioPuppeteerVideoServiceOptions,
} from 'wdio-puppeteer-video-service'

const recording = {
  scope: 'test',
  attempts: 'all',
  retain: 'failures',
  windowChanges: 'segment',
} satisfies RecordingOptions

const capture = {
  viewport: { width: 1280, height: 720 },
  fps: 30,
} satisfies CaptureOptions

const options = {
  outputDir: 'videos',
  recording,
  capture,
  processing: { format: 'webm', timing: 'after-test' },
  concurrency: {
    startMode: 'blocking',
    maxPostProcessesPerProcess: 1,
    maxPostProcessesGlobal: 1,
  },
  artifacts: { naming: { style: 'test' } },
  profile: 'default',
  failurePolicy: 'warn',
} satisfies WdioPuppeteerVideoServiceOptions

export default new WdioPuppeteerVideoService(options)
