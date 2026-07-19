import type { Services } from '@wdio/types'
import WdioPuppeteerVideoService, {
  type CaptureOptions,
  launcher,
  type RecordingOptions,
  type WdioPuppeteerVideoServiceOptions,
} from 'wdio-puppeteer-video-service'
import {
  isVideoManifest,
  MANIFEST_SCHEMA_VERSION,
  type VideoManifestV1,
} from 'wdio-puppeteer-video-service/manifest'
import WdioPuppeteerVideoReporter, {
  type WdioPuppeteerVideoReporterOptions,
} from 'wdio-puppeteer-video-service/reporter'

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
  integrations: { allure: { attach: 'failures', maxBytes: 25_000_000 } },
  profile: 'default',
  failurePolicy: 'warn',
} satisfies WdioPuppeteerVideoServiceOptions

export const serviceRegistration = [
  'puppeteer-video',
  options,
] satisfies Services.ServiceEntry
export const workerClass: Services.ServiceClass = WdioPuppeteerVideoService
export const launcherClass: Services.ServiceClass = launcher
export default serviceRegistration

const reporterOptions = {
  outputDir: 'videos',
  reportFileName: 'video-report.html',
} satisfies WdioPuppeteerVideoReporterOptions

export const reporter = new WdioPuppeteerVideoReporter(reporterOptions)

export const acceptsManifest = (
  value: unknown,
): VideoManifestV1 | undefined => {
  return isVideoManifest(value) &&
    value.schemaVersion === MANIFEST_SCHEMA_VERSION
    ? value
    : undefined
}
