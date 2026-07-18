import WdioPuppeteerVideoService, {
  type CaptureOptions,
  type RecordingOptions,
  type WdioPuppeteerVideoServiceOptions,
} from 'wdio-puppeteer-video-service'
import {
  isVideoManifest,
  MANIFEST_SCHEMA_VERSION,
  type VideoManifestV1,
} from 'wdio-puppeteer-video-service/manifest'

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

export const acceptsManifest = (
  value: unknown,
): VideoManifestV1 | undefined => {
  return isVideoManifest(value) &&
    value.schemaVersion === MANIFEST_SCHEMA_VERSION
    ? value
    : undefined
}
