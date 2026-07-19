import WdioPuppeteerVideoLauncher from './launcher.js'
import WdioPuppeteerVideoService from './service.js'

export type {
  AllureAttachmentMode,
  AllureIntegrationOptions,
  ArtifactNameOverflowStrategy,
  ArtifactNameStyle,
  ArtifactNamingOptions,
  ArtifactOptions,
  CaptureCrop,
  CaptureOptions,
  CaptureViewport,
  ConcurrencyOptions,
  FailurePolicy,
  IntegrationOptions,
  LogLevel,
  Mp4Mode,
  OutputFormat,
  ProcessingFfmpegOptions,
  ProcessingMergeOptions,
  ProcessingOptions,
  ProcessingTiming,
  ProcessingTranscodeOptions,
  RecordingAttempts,
  RecordingFilterOptions,
  RecordingOptions,
  RecordingRetention,
  RecordingScope,
  RecordingStartMode,
  ServiceProfile,
  WdioPuppeteerVideoServiceOptions,
  WindowChangeBehavior,
} from './types.js'
export { WdioPuppeteerVideoLauncher as launcher, WdioPuppeteerVideoService }
export default WdioPuppeteerVideoService
