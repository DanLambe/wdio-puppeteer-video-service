import { randomUUID } from 'node:crypto'
import type {
  Page,
  Browser as PuppeteerBrowser,
  ScreenRecorder,
} from 'puppeteer-core'
import { generateVideoReportForRun } from '../reporter/report-generator.js'
import type { ResolvedWdioPuppeteerVideoServiceOptions } from '../types.js'
import { AllureVideoIntegration } from './allure-integration.js'
import {
  type ClockBoundary,
  type FileSystemBoundary,
  nodeFileSystem,
  nodeProcess,
  type ProcessBoundary,
  systemClock,
} from './boundaries.js'
import { type StartScreencastOptions, startScreencast } from './capture.js'
import {
  FfmpegProcessRegistry,
  type FfmpegRunnerDependencies,
  type RunFfmpegOptions,
  runFfmpeg,
} from './ffmpeg-runner.js'
import type { ServiceLogger } from './logging.js'
import { writeLog } from './logging.js'
import {
  aggregateManifestRun,
  createManifestRunContext,
} from './manifest-runtime.js'
import {
  connectPuppeteerWithTimeout,
  type ProtocolBrowser,
} from './protocol.js'
import {
  PostProcessSlotScheduler,
  RecordingSlotScheduler,
} from './recording-slots.js'
import {
  createWorkerRecordingCoordinator,
  type RecordingCoordinatorFactory,
} from './worker-recording-coordinator.js'

export type UuidFactory = () => string
export type PuppeteerConnector = (
  browser: ProtocolBrowser,
  timeoutMs: number,
) => Promise<PuppeteerBrowser>
export type ScreencastStarter = (
  page: Page,
  options: StartScreencastOptions,
) => Promise<ScreenRecorder>
export type WorkerFfmpegRunner = (
  options: RunFfmpegOptions,
  processRegistry: FfmpegProcessRegistry,
) => Promise<boolean>

export interface WorkerCompositionOverrides {
  readonly clock?: ClockBoundary
  readonly fileSystem?: FileSystemBoundary
  readonly process?: ProcessBoundary
  readonly uuid?: UuidFactory
  readonly connectPuppeteer?: PuppeteerConnector
  readonly startScreencast?: ScreencastStarter
  readonly runFfmpeg?: WorkerFfmpegRunner
  readonly createRecordingCoordinator?: RecordingCoordinatorFactory
  readonly ffmpeg?: Omit<FfmpegRunnerDependencies, 'clock' | 'processRegistry'>
  readonly writeLog?: typeof writeLog
}

export interface WorkerCompositionRoot {
  readonly clock: ClockBoundary
  readonly fileSystem: FileSystemBoundary
  readonly process: ProcessBoundary
  readonly uuid: UuidFactory
  readonly connectPuppeteer: PuppeteerConnector
  readonly startScreencast: ScreencastStarter
  readonly runFfmpeg: WorkerFfmpegRunner
  readonly createRecordingCoordinator: RecordingCoordinatorFactory
  readonly writeLog: typeof writeLog
  createFfmpegProcessRegistry(): FfmpegProcessRegistry
  createAllureIntegration(
    options: ResolvedWdioPuppeteerVideoServiceOptions['integrations']['allure'],
    log: ServiceLogger,
  ): AllureVideoIntegration | undefined
  createPostProcessSlotScheduler(
    options: ResolvedWdioPuppeteerVideoServiceOptions,
    log: ServiceLogger,
  ): PostProcessSlotScheduler
  createRecordingSlotScheduler(
    options: ResolvedWdioPuppeteerVideoServiceOptions,
    log: ServiceLogger,
  ): RecordingSlotScheduler
}

export const createWorkerCompositionRoot = (
  overrides: WorkerCompositionOverrides = {},
): WorkerCompositionRoot => {
  const clock = overrides.clock ?? systemClock
  const fileSystem = overrides.fileSystem ?? nodeFileSystem
  const processBoundary = overrides.process ?? nodeProcess
  const schedulerDependencies = {
    clock,
    fileSystem,
    process: processBoundary,
  }
  const connectPuppeteer =
    overrides.connectPuppeteer ??
    ((browser, timeoutMs) =>
      connectPuppeteerWithTimeout(browser, timeoutMs, clock))
  const runWorkerFfmpeg =
    overrides.runFfmpeg ??
    ((options, processRegistry) =>
      runFfmpeg(options, {
        ...overrides.ffmpeg,
        clock,
        processRegistry,
      }))

  return Object.freeze({
    clock,
    fileSystem,
    process: processBoundary,
    uuid: overrides.uuid ?? randomUUID,
    connectPuppeteer,
    startScreencast: overrides.startScreencast ?? startScreencast,
    runFfmpeg: runWorkerFfmpeg,
    createRecordingCoordinator:
      overrides.createRecordingCoordinator ?? createWorkerRecordingCoordinator,
    writeLog: overrides.writeLog ?? writeLog,
    createFfmpegProcessRegistry() {
      return new FfmpegProcessRegistry()
    },
    createAllureIntegration(
      options: ResolvedWdioPuppeteerVideoServiceOptions['integrations']['allure'],
      log: ServiceLogger,
    ) {
      return options ? new AllureVideoIntegration(options, log) : undefined
    },
    createRecordingSlotScheduler(
      options: ResolvedWdioPuppeteerVideoServiceOptions,
      log: ServiceLogger,
    ) {
      return new RecordingSlotScheduler(
        {
          maxConcurrentRecordings: options.concurrency.maxRecordingsPerProcess,
          maxGlobalRecordings: options.concurrency.maxRecordingsGlobal,
          outputDir: options.outputDir,
          recordingStartMode: options.concurrency.startMode,
          recordingStartTimeoutMs: options.concurrency.startTimeoutMs,
          globalRecordingLockDir: options.concurrency.lockDir,
        },
        log,
        schedulerDependencies,
      )
    },
    createPostProcessSlotScheduler(
      options: ResolvedWdioPuppeteerVideoServiceOptions,
      log: ServiceLogger,
    ) {
      return new PostProcessSlotScheduler(
        {
          maxConcurrentPostProcesses:
            options.concurrency.maxPostProcessesPerProcess,
          maxGlobalPostProcesses: options.concurrency.maxPostProcessesGlobal,
          outputDir: options.outputDir,
          postProcessStartMode: options.concurrency.postProcessStartMode,
          postProcessStartTimeoutMs:
            options.concurrency.postProcessStartTimeoutMs,
          globalRecordingLockDir: options.concurrency.lockDir,
        },
        log,
        schedulerDependencies,
      )
    },
  })
}

export interface LauncherCompositionOverrides {
  readonly aggregateManifestRun?: typeof aggregateManifestRun
  readonly createManifestRunContext?: typeof createManifestRunContext
  readonly generateVideoReportForRun?: typeof generateVideoReportForRun
  readonly writeLog?: typeof writeLog
}

export interface LauncherCompositionRoot {
  readonly aggregateManifestRun: typeof aggregateManifestRun
  readonly createManifestRunContext: typeof createManifestRunContext
  readonly generateVideoReportForRun: typeof generateVideoReportForRun
  readonly writeLog: typeof writeLog
}

export const createLauncherCompositionRoot = (
  overrides: LauncherCompositionOverrides = {},
): LauncherCompositionRoot => {
  return Object.freeze({
    aggregateManifestRun:
      overrides.aggregateManifestRun ?? aggregateManifestRun,
    createManifestRunContext:
      overrides.createManifestRunContext ?? createManifestRunContext,
    generateVideoReportForRun:
      overrides.generateVideoReportForRun ?? generateVideoReportForRun,
    writeLog: overrides.writeLog ?? writeLog,
  })
}
