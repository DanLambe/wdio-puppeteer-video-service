import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Frameworks } from '@wdio/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WdioPuppeteerVideoLauncher from '../../src/launcher.js'
import type { CaptureSession } from '../../src/service/capture-session.js'
import type { FfmpegRuntime } from '../../src/service/ffmpeg-runtime.js'
import type { MediaPipeline } from '../../src/service/media-pipeline.js'
import { WorkerRecordingCoordinator } from '../../src/service/worker-recording-coordinator.js'
import WdioPuppeteerVideoServiceRuntime from '../../src/service.js'
import WdioPuppeteerVideoService, {
  type CharacterizedServiceOptions,
} from './characterized-service.js'

const createTest = (
  overrides: Partial<Frameworks.Test> = {},
): Frameworks.Test => {
  return {
    type: 'test',
    title: 'default test',
    parent: 'suite',
    fullTitle: 'suite default test',
    pending: false,
    file: 'tests/specs/e2e.test.ts',
    fullName: 'suite default test',
    ctx: {},
    ...overrides,
  }
}

const RETRY_RECORDING_SPEC_PATH = 'tests/advanced/specs/retry-recording.spec.ts'
const RETRY_RECORDING_SPECS = [RETRY_RECORDING_SPEC_PATH]

type RetryLauncherService = {
  onPrepare: () => Promise<void>
  onWorkerStart: (
    cid: string,
    capabilities: WebdriverIO.Capabilities,
    specs: string[],
    args: object,
  ) => void
  onWorkerEnd: (
    cid: string,
    exitCode: number,
    specs: string[],
    retries: number,
  ) => void
  onComplete: () => Promise<void>
}

type RetryWorkerService = {
  beforeSession: (
    config: unknown,
    capabilities: WebdriverIO.Capabilities,
    specs: string[],
    cid: string,
  ) => Promise<void>
  beforeTest: (test: Frameworks.Test, context: unknown) => Promise<void>
}

type RecordingOutput = {
  outputFormat: 'webm' | 'mp4'
  outputPath: string
  recordingFormat: 'webm' | 'mp4'
  recordingPath: string
  transcodeEnabled: boolean
}

type RecordingOutputService = {
  _captureSession: CaptureSession
  _createRecordingOutput: () => RecordingOutput
  _ffmpegRuntime: Pick<FfmpegRuntime, 'shouldTranscode'>
  _log: (level: string, message: string) => void
}

const createRecordingOutputHarness = (
  options: CharacterizedServiceOptions,
  shouldTranscode: boolean,
): { service: RecordingOutputService; warnMessages: string[] } => {
  const service = new WdioPuppeteerVideoService({
    outputDir: 'artifacts',
    ...options,
  }) as unknown as RecordingOutputService
  const warnMessages: string[] = []
  service._captureSession.beginRecording('capture')
  service._ffmpegRuntime.shouldTranscode = () => shouldTranscode
  service._log = (level, message) => {
    if (level === 'warn') {
      warnMessages.push(message)
    }
  }

  return { service, warnMessages }
}

const withTempDir = async (
  run: (tempDir: string) => Promise<void>,
): Promise<void> => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wdio-video-service-unit-'),
  )

  try {
    await run(tempDir)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

const createRetryLauncherService = (
  outputDir: string,
): RetryLauncherService => {
  return new WdioPuppeteerVideoLauncher({
    outputDir,
    recording: { attempts: 'retries' },
  })
}

const primeRetryStateForSecondWorker = async (
  launcherService: RetryLauncherService,
  firstCapabilities: WebdriverIO.Capabilities,
  specs: string[],
  secondCapabilities = firstCapabilities,
): Promise<Record<string, unknown>> => {
  await launcherService.onPrepare()
  launcherService.onWorkerStart('0-0', firstCapabilities, specs, {})
  await launcherService.onWorkerEnd('0-0', 1, specs, 0)
  const workerConfig: Record<string, unknown> = { framework: 'mocha' }
  launcherService.onWorkerStart('0-0', secondCapabilities, specs, workerConfig)
  return workerConfig
}

const createRetryWorkerHarness = (
  outputDir: string,
): { workerService: RetryWorkerService; seenRetryCounts: number[] } => {
  const seenRetryCounts: number[] = []
  const workerService = new WdioPuppeteerVideoServiceRuntime(
    {
      outputDir,
      recording: { attempts: 'retries' },
    },
    undefined,
    undefined,
    {
      createRecordingCoordinator: (options) =>
        new WorkerRecordingCoordinator({
          ...options,
          actions: {
            ...options.actions,
            getAvailability: () => ({ available: true }),
            startRecording: async (_metadata, retryCount) => {
              seenRetryCounts.push(retryCount)
              return true
            },
          },
        }),
    },
  )

  return {
    workerService,
    seenRetryCounts,
  }
}

const runSpecFileRetryBeforeTest = async (
  workerService: RetryWorkerService,
  workerConfig: Record<string, unknown>,
  workerCapabilities: WebdriverIO.Capabilities,
  specs: string[],
): Promise<void> => {
  const specPath = specs[0] ?? RETRY_RECORDING_SPEC_PATH
  await workerService.beforeSession(
    workerConfig,
    workerCapabilities,
    specs,
    '0-0',
  )
  await workerService.beforeTest(
    createTest({
      title: 'spec file retry candidate',
      file: specPath,
    }),
    {},
  )
}

describe('WdioPuppeteerVideoService unit', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('constructor rejects invalid runtime option values', () => {
    expect(
      () =>
        new WdioPuppeteerVideoService({
          outputFormat: 'avi',
        } as never),
    ).toThrow('processing.format')
  })

  it('before hook does not initialize FFmpeg eagerly', async () => {
    const ensureReady = vi.fn(async () => true)
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _ffmpegRuntime: Pick<FfmpegRuntime, 'ensureReady'>
      before: (
        capabilities: WebdriverIO.Capabilities,
        specs: string[],
        browser: unknown,
      ) => Promise<void>
    }
    service._ffmpegRuntime.ensureReady = ensureReady

    await service.before({}, ['tests/specs/e2e.test.ts'], {
      sessionId: 'abc123',
      capabilities: {
        browserName: 'chrome',
      },
    })

    expect(ensureReady).not.toHaveBeenCalled()
  })

  it('checks FFmpeg readiness only when retry recording actually starts', async () => {
    const ensureReady = vi.fn(async () => true)
    const service = new WdioPuppeteerVideoService({
      recordOnRetries: true,
    }) as unknown as {
      _captureSession: CaptureSession
      _ffmpegRuntime: Pick<FfmpegRuntime, 'ensureReady'>
      _isChromium: boolean
      _runSerializedRecordingTask: (task: () => Promise<void>) => Promise<void>
      beforeTest: (test: Frameworks.Test, context: unknown) => Promise<void>
      _startRecording: () => Promise<boolean>
    }

    service._isChromium = true
    service._captureSession.setBrowser({} as never)
    service._runSerializedRecordingTask = async (task) => {
      await task()
    }
    service._ffmpegRuntime.ensureReady = ensureReady
    service._startRecording = async () => service._ffmpegRuntime.ensureReady()

    await service.beforeTest(createTest({ title: 'retry lazy probe' }), {})
    expect(ensureReady).not.toHaveBeenCalled()

    await service.beforeTest(
      createTest({
        title: 'retry lazy probe',
        _currentRetry: 1,
      }),
      {},
    )
    expect(ensureReady).toHaveBeenCalledOnce()

    service._captureSession.resetRecording()
    await service.beforeTest(
      createTest({
        title: 'retry lazy probe',
        _currentRetry: 2,
      }),
      {},
    )
    expect(ensureReady).toHaveBeenCalledTimes(2)
  })

  it('recordOnRetries hydrates spec-file retry attempts across worker restarts', async () => {
    await withTempDir(async (tempDir) => {
      const specs = RETRY_RECORDING_SPECS
      const launcherCapabilities = {
        browserName: 'chrome',
        platformName: 'Windows',
        'goog:chromeOptions': {
          prefs: {
            'download.default_directory': 'C:/tmp/downloads-attempt-1',
          },
        },
        'wdio:chromedriverOptions': {
          port: 9515,
        },
      } as unknown as WebdriverIO.Capabilities
      const workerCapabilities = {
        browserName: 'chrome',
        platformName: 'Windows',
        'goog:chromeOptions': {
          prefs: {
            'download.default_directory': 'C:/tmp/downloads-attempt-2',
          },
        },
        'wdio:chromedriverOptions': {
          port: 9516,
        },
      } as unknown as WebdriverIO.Capabilities

      const launcherService = createRetryLauncherService(tempDir)
      const workerConfig = await primeRetryStateForSecondWorker(
        launcherService,
        launcherCapabilities,
        specs,
      )

      const { workerService, seenRetryCounts } =
        createRetryWorkerHarness(tempDir)
      await runSpecFileRetryBeforeTest(
        workerService,
        workerConfig,
        workerCapabilities,
        specs,
      )

      expect(seenRetryCounts).toEqual([1])
      await launcherService.onComplete()
    })
  })

  it('recordOnRetries does not hydrate spec-file retry attempt for different browsers', async () => {
    await withTempDir(async (tempDir) => {
      const specs = RETRY_RECORDING_SPECS
      const launcherCapabilities = {
        browserName: 'chrome',
      } as unknown as WebdriverIO.Capabilities
      const workerCapabilities = {
        browserName: 'firefox',
      } as unknown as WebdriverIO.Capabilities

      const launcherService = createRetryLauncherService(tempDir)
      const workerConfig = await primeRetryStateForSecondWorker(
        launcherService,
        launcherCapabilities,
        specs,
        workerCapabilities,
      )

      const { workerService, seenRetryCounts } =
        createRetryWorkerHarness(tempDir)
      await runSpecFileRetryBeforeTest(
        workerService,
        workerConfig,
        workerCapabilities,
        specs,
      )

      expect(seenRetryCounts).toEqual([])
      await launcherService.onComplete()
    })
  })

  it('segmentOnWindowSwitch can disable window command segmentation', async () => {
    const service = new WdioPuppeteerVideoService({
      segmentOnWindowSwitch: false,
    }) as unknown as {
      _captureSession: CaptureSession
      _isChromium: boolean
      _runSerializedRecordingTask: (task: () => Promise<void>) => Promise<void>
      beforeCommand: (commandName: string) => Promise<void>
      afterCommand: (commandName: string) => Promise<void>
    }

    service._isChromium = true
    service._captureSession.setBrowser({} as never)
    service._captureSession.beginRecording('active_test')
    let serializedTaskRuns = 0
    service._runSerializedRecordingTask = async () => {
      serializedTaskRuns += 1
    }

    await service.beforeCommand('closeWindow')
    await service.afterCommand('switchWindow')

    expect(serializedTaskRuns).toBe(0)
  })

  it('startRecording skips the capture engine when slot acquisition fails', async () => {
    const startCapture = vi.fn(async () => ({ started: false as const }))
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _captureEngine: {
        startCapture: typeof startCapture
      }
      _captureSession: CaptureSession
      _ffmpegRuntime: Pick<FfmpegRuntime, 'ensureReady'>
      _recordingSlotScheduler: {
        acquire: () => Promise<boolean>
        release: () => Promise<void>
      }
      _startRecording: () => Promise<boolean>
    }

    service._captureSession.setBrowser({} as never)
    service._captureSession.beginRecording('slot-order')
    service._captureEngine.startCapture = startCapture
    service._ffmpegRuntime.ensureReady = async () => true
    service._recordingSlotScheduler = {
      acquire: async () => false,
      release: async () => {},
    }

    await expect(service._startRecording()).resolves.toBe(false)
    expect(startCapture).not.toHaveBeenCalled()
  })

  it('startRecording releases the slot when the capture engine cannot start', async () => {
    const callOrder: string[] = []
    const startCapture = vi.fn(async () => {
      callOrder.push('startCapture')
      return { started: false as const }
    })
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _captureEngine: {
        startCapture: typeof startCapture
      }
      _captureSession: CaptureSession
      _ffmpegRuntime: Pick<FfmpegRuntime, 'ensureReady'>
      _recordingSlotScheduler: {
        acquire: () => Promise<boolean>
        release: () => Promise<void>
      }
      _startRecording: () => Promise<boolean>
    }

    service._captureSession.setBrowser({} as never)
    service._captureSession.beginRecording('slot-release')
    service._captureEngine.startCapture = startCapture
    service._ffmpegRuntime.ensureReady = async () => true
    service._recordingSlotScheduler = {
      acquire: async () => {
        callOrder.push('acquireRecordingSlot')
        return true
      },
      release: async () => {
        callOrder.push('releaseRecordingSlot')
      },
    }

    await expect(service._startRecording()).resolves.toBe(false)
    expect(callOrder).toEqual([
      'acquireRecordingSlot',
      'startCapture',
      'releaseRecordingSlot',
    ])
  })

  it('queues deferred transcode task when postProcessMode is deferred', async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'wdio-video-service-unit-'),
    )
    try {
      const recordingPath = path.join(tempDir, 'segment_part1.webm')
      const outputPath = path.join(tempDir, 'segment_part1.mp4')
      await fs.writeFile(recordingPath, 'not-empty')

      const service = new WdioPuppeteerVideoService({
        postProcessMode: 'deferred',
        outputFormat: 'mp4',
        transcode: { enabled: true },
        mergeSegments: { enabled: false },
      }) as unknown as {
        _captureSession: CaptureSession
        _deferredPostProcessTasks: Array<{
          kind: string
          inputPath?: string
          outputPath?: string
        }>
        _finalizeSegment: (segment: {
          recordingPath: string
          outputPath: string
          outputFormat: 'webm' | 'mp4'
          recordingFormat: 'webm' | 'mp4'
          transcode: boolean
          transcodeOptions: { deleteOriginal: boolean; ffmpegArgs?: string[] }
        }) => Promise<void>
      }

      await service._finalizeSegment({
        recordingPath,
        outputPath,
        outputFormat: 'mp4',
        recordingFormat: 'webm',
        transcode: true,
        transcodeOptions: {
          deleteOriginal: true,
        },
      })

      expect(service._captureSession.recordedPaths).toContain(recordingPath)
      expect(service._deferredPostProcessTasks).toHaveLength(1)
      expect(service._deferredPostProcessTasks[0]).toMatchObject({
        kind: 'transcode',
        inputPath: recordingPath,
        outputPath,
      })
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('queues deferred merge task for multi-segment recordings', async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'wdio-video-service-unit-'),
    )
    try {
      const service = new WdioPuppeteerVideoService({
        outputDir: tempDir,
        postProcessMode: 'deferred',
        outputFormat: 'mp4',
        transcode: { enabled: true },
        mergeSegments: { enabled: true, deleteSegments: true },
      }) as unknown as {
        _captureSession: CaptureSession
        _deferredPostProcessTasks: Array<{
          kind: string
          segmentPaths?: string[]
          mergedPath?: string
          transcodeToMp4?: { outputPath: string }
        }>
        _queueDeferredMergeForCurrentTest: () => Promise<void>
      }

      service._captureSession.beginRecording('merge_test')
      service._captureSession.addRecordedPath(
        path.join(tempDir, 'merge_test_part1.webm'),
      )
      service._captureSession.addRecordedPath(
        path.join(tempDir, 'merge_test_part2.webm'),
      )

      await service._queueDeferredMergeForCurrentTest()

      expect(service._deferredPostProcessTasks).toHaveLength(1)
      expect(service._deferredPostProcessTasks[0]).toMatchObject({
        kind: 'merge',
        segmentPaths: [
          path.join(tempDir, 'merge_test_part1.webm'),
          path.join(tempDir, 'merge_test_part2.webm'),
        ],
      })
      expect(
        service._deferredPostProcessTasks[0]?.transcodeToMp4?.outputPath,
      ).toBe(path.join(tempDir, 'merge_test.mp4'))
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('records the original media before applying the error failure policy', async () => {
    await withTempDir(async (tempDir) => {
      const inputPath = path.join(tempDir, 'input.webm')
      const outputPath = path.join(tempDir, 'output.mp4')
      await fs.writeFile(inputPath, 'source-media', 'utf8')
      const service = new WdioPuppeteerVideoServiceRuntime({
        outputDir: tempDir,
        concurrency: { maxPostProcessesPerProcess: 1 },
        failurePolicy: 'error',
        processing: {
          format: 'mp4',
          transcode: { enabled: true },
        },
      }) as unknown as {
        _finalizeSegment: (segment: {
          recordingPath: string
          outputPath: string
          outputFormat: 'mp4'
          recordingFormat: 'webm'
          transcode: true
          transcodeOptions: { deleteOriginal: boolean }
        }) => Promise<void>
        _captureSession: CaptureSession
        _mediaPipeline: Pick<MediaPipeline, 'reportFailure' | 'transcode'>
      }
      const transcode = vi.fn(async () => undefined)
      const reportFailure = vi.fn((message: string) => {
        expect(service._captureSession.recordedPaths).toContain(inputPath)
        throw new Error(`[WdioPuppeteerVideoService] ${message}`)
      })
      service._mediaPipeline.transcode = transcode
      service._mediaPipeline.reportFailure = reportFailure

      await expect(
        service._finalizeSegment({
          recordingPath: inputPath,
          outputPath,
          outputFormat: 'mp4',
          recordingFormat: 'webm',
          transcode: true,
          transcodeOptions: { deleteOriginal: true },
        }),
      ).rejects.toThrow('keeping original recording')

      expect(transcode).toHaveBeenCalledWith({
        deleteOriginal: true,
        inputPath,
        outputPath,
      })
      expect(reportFailure).toHaveBeenCalledWith(
        `Transcode failed, keeping original recording: ${inputPath}`,
        true,
      )
      expect(service._captureSession.recordedPaths).toContain(inputPath)
      await expect(fs.readFile(inputPath, 'utf8')).resolves.toBe('source-media')
    })
  })

  it('runSerializedRecordingTask logs task failures and continues with later tasks', async () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _log: (level: string, message: string, details?: unknown) => void
      _runSerializedRecordingTask: (task: () => Promise<void>) => Promise<void>
    }

    const seenTasks: string[] = []
    const loggedErrors: unknown[] = []
    service._log = (level, _message, details) => {
      if (level === 'error') {
        loggedErrors.push(details)
      }
    }

    await Promise.all([
      service._runSerializedRecordingTask(async () => {
        seenTasks.push('first')
        throw new Error('boom')
      }),
      service._runSerializedRecordingTask(async () => {
        seenTasks.push('second')
      }),
    ])

    expect(seenTasks).toEqual(['first', 'second'])
    expect(loggedErrors).toHaveLength(1)
  })

  it('flushes deferred transcode queue in after-hook post processing', async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'wdio-video-service-unit-'),
    )
    try {
      const inputPath = path.join(tempDir, 'queued.webm')
      const outputPath = path.join(tempDir, 'queued.mp4')
      await fs.writeFile(inputPath, 'queued-file')

      const service = new WdioPuppeteerVideoService({
        postProcessMode: 'deferred',
      }) as unknown as {
        _deferredPostProcessTasks: Array<{
          kind: 'transcode'
          inputPath: string
          outputPath: string
          deleteOriginal: boolean
          ffmpegArgs?: string[]
        }>
        _mediaPipeline: Pick<MediaPipeline, 'transcode'>
        _flushDeferredPostProcessTasks: () => Promise<void>
      }

      const seenCalls: Array<Parameters<MediaPipeline['transcode']>[0]> = []
      service._deferredPostProcessTasks.push({
        kind: 'transcode',
        inputPath,
        outputPath,
        deleteOriginal: false,
      })
      service._mediaPipeline.transcode = async (options) => {
        seenCalls.push(options)
        return outputPath
      }

      await service._flushDeferredPostProcessTasks()

      expect(seenCalls).toEqual([
        {
          deleteOriginal: false,
          inputPath,
          outputPath,
        },
      ])
      expect(service._deferredPostProcessTasks).toHaveLength(0)
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('flushDeferredPostProcessTasks dispatches merge and transcode work in queue order', async () => {
    const service = new WdioPuppeteerVideoService({
      postProcessMode: 'deferred',
    }) as unknown as {
      _deferredPostProcessTasks: Array<{
        kind: 'merge' | 'transcode'
        inputPath?: string
        outputPath?: string
        deleteOriginal?: boolean
        mergedPath?: string
        segmentPaths?: string[]
        deleteSegments?: boolean
      }>
      _executeDeferredMergeTask: (task: { kind: 'merge' }) => Promise<void>
      _executeDeferredTranscodeTask: (task: {
        kind: 'transcode'
      }) => Promise<void>
      _flushDeferredPostProcessTasks: () => Promise<void>
      _log: (level: string, message: string) => void
    }

    const callOrder: string[] = []
    service._log = () => {}
    service._executeDeferredMergeTask = async () => {
      callOrder.push('merge')
    }
    service._executeDeferredTranscodeTask = async () => {
      callOrder.push('transcode')
    }
    service._deferredPostProcessTasks.push(
      {
        kind: 'merge',
        mergedPath: 'merged.webm',
        segmentPaths: ['part1.webm'],
        deleteSegments: true,
      },
      {
        kind: 'transcode',
        inputPath: 'input.webm',
        outputPath: 'output.mp4',
        deleteOriginal: true,
      },
    )

    await service._flushDeferredPostProcessTasks()

    expect(callOrder).toEqual(['merge', 'transcode'])
    expect(service._deferredPostProcessTasks).toHaveLength(0)
  })

  it('drains deferred work after a task fails and rethrows the first failure', async () => {
    const service = new WdioPuppeteerVideoService({
      postProcessMode: 'deferred',
    }) as unknown as {
      _deferredPostProcessTasks: Array<{
        kind: 'transcode'
        inputPath: string
        outputPath: string
        deleteOriginal: boolean
      }>
      _executeDeferredTranscodeTask: (task: {
        kind: 'transcode'
        inputPath: string
      }) => Promise<void>
      _flushDeferredPostProcessTasks: () => Promise<void>
      _log: (level: string, message: string) => void
    }
    const callOrder: string[] = []
    service._log = () => {}
    service._executeDeferredTranscodeTask = async (task) => {
      callOrder.push(task.inputPath)
      if (task.inputPath === 'first.webm') {
        throw new Error('first deferred failure')
      }
      throw new Error('second deferred failure')
    }
    service._deferredPostProcessTasks.push(
      {
        kind: 'transcode',
        inputPath: 'first.webm',
        outputPath: 'first.mp4',
        deleteOriginal: true,
      },
      {
        kind: 'transcode',
        inputPath: 'second.webm',
        outputPath: 'second.mp4',
        deleteOriginal: true,
      },
    )

    await expect(service._flushDeferredPostProcessTasks()).rejects.toThrow(
      'first deferred failure',
    )
    expect(callOrder).toEqual(['first.webm', 'second.webm'])
    expect(service._deferredPostProcessTasks).toHaveLength(0)
  })

  it('reports missing deferred inputs and dispatches existing inputs to the media pipeline', async () => {
    await withTempDir(async (tempDir) => {
      const inputPath = path.join(tempDir, 'input.webm')
      const outputPath = path.join(tempDir, 'output.mp4')
      const service = new WdioPuppeteerVideoService({}) as unknown as {
        _executeDeferredTranscodeTask: (task: {
          kind: 'transcode'
          inputPath: string
          outputPath: string
          deleteOriginal: boolean
          ffmpegArgs?: string[]
        }) => Promise<void>
        _mediaPipeline: Pick<MediaPipeline, 'reportFailure' | 'transcode'>
      }

      const transcode = vi.fn(async () => outputPath)
      const reportFailure = vi.fn()
      service._mediaPipeline.transcode = transcode
      service._mediaPipeline.reportFailure = reportFailure

      await service._executeDeferredTranscodeTask({
        kind: 'transcode',
        inputPath,
        outputPath,
        deleteOriginal: true,
      })
      expect(transcode).not.toHaveBeenCalled()
      expect(reportFailure).toHaveBeenCalledWith(
        `Deferred transcode input is missing: ${inputPath}`,
      )

      await fs.writeFile(inputPath, 'source', 'utf8')
      await service._executeDeferredTranscodeTask({
        kind: 'transcode',
        inputPath,
        outputPath,
        deleteOriginal: true,
        ffmpegArgs: ['-preset', 'slow'],
      })

      expect(transcode).toHaveBeenCalledWith({
        deleteOriginal: true,
        ffmpegArgs: ['-preset', 'slow'],
        inputPath,
        outputPath,
      })
    })
  })

  it('applies the error failure policy to a missing deferred input', async () => {
    const service = new WdioPuppeteerVideoService({
      failurePolicy: 'error',
    }) as unknown as {
      _executeDeferredTranscodeTask: (task: {
        kind: 'transcode'
        inputPath: string
        outputPath: string
        deleteOriginal: boolean
      }) => Promise<void>
    }

    await expect(
      service._executeDeferredTranscodeTask({
        kind: 'transcode',
        inputPath: 'missing-input.webm',
        outputPath: 'unused-output.mp4',
        deleteOriginal: true,
      }),
    ).rejects.toThrow('Deferred transcode input is missing')
  })

  it('executeDeferredMergeTask creates a follow-up transcode task when configured', async () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _executeDeferredMergeTask: (task: {
        kind: 'merge'
        segmentPaths: string[]
        mergedPath: string
        deleteSegments: boolean
        transcodeToMp4?: {
          outputPath: string
          deleteOriginal: boolean
          ffmpegArgs?: string[]
        }
      }) => Promise<void>
      _executeDeferredTranscodeTask: (task: {
        kind: 'transcode'
        inputPath: string
        outputPath: string
        deleteOriginal: boolean
        ffmpegArgs?: string[]
      }) => Promise<void>
      _mediaPipeline: Pick<MediaPipeline, 'merge'>
    }

    const transcodeTasks: Array<{
      kind: 'transcode'
      inputPath: string
      outputPath: string
      deleteOriginal: boolean
      ffmpegArgs?: string[]
    }> = []
    const merge = vi.fn(async () => 'merged.webm')
    service._mediaPipeline.merge = merge
    service._executeDeferredTranscodeTask = async (task) => {
      transcodeTasks.push(task)
    }

    await service._executeDeferredMergeTask({
      kind: 'merge',
      segmentPaths: ['part1.webm', 'part2.webm'],
      mergedPath: 'merged.webm',
      deleteSegments: true,
      transcodeToMp4: {
        outputPath: 'merged.mp4',
        deleteOriginal: true,
        ffmpegArgs: ['-preset', 'slow'],
      },
    })

    expect(merge).toHaveBeenCalledWith({
      segmentPaths: ['part1.webm', 'part2.webm'],
      mergedPath: 'merged.webm',
      deleteSegments: true,
      writeFailureContext: 'deferred merge',
      ffmpegOperation: 'deferred segment merge',
    })
    expect(transcodeTasks).toEqual([
      {
        kind: 'transcode',
        inputPath: 'merged.webm',
        outputPath: 'merged.mp4',
        deleteOriginal: true,
        ffmpegArgs: ['-preset', 'slow'],
      },
    ])
  })

  it('dropDeferredPostProcessTasksForPaths removes tasks that touch blocked paths', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _deferredPostProcessTasks: Array<{
        kind: 'merge' | 'transcode'
        inputPath?: string
        outputPath?: string
        mergedPath?: string
        segmentPaths?: string[]
        transcodeToMp4?: { outputPath: string }
      }>
      _dropDeferredPostProcessTasksForPaths: (paths: string[]) => void
    }

    service._deferredPostProcessTasks.push(
      {
        kind: 'transcode',
        inputPath: 'keep-input.webm',
        outputPath: 'keep-output.mp4',
      },
      {
        kind: 'transcode',
        inputPath: 'blocked-input.webm',
        outputPath: 'blocked-output.mp4',
      },
      {
        kind: 'merge',
        mergedPath: 'blocked-merged.webm',
        segmentPaths: ['part1.webm', 'part2.webm'],
        transcodeToMp4: { outputPath: 'blocked-merged.mp4' },
      },
    )

    service._dropDeferredPostProcessTasksForPaths([
      'blocked-input.webm',
      'blocked-merged.mp4',
    ])

    expect(service._deferredPostProcessTasks).toEqual([
      {
        kind: 'transcode',
        inputPath: 'keep-input.webm',
        outputPath: 'keep-output.mp4',
      },
    ])
  })

  it('buildTestSlug is deterministic, sanitized, and retry-aware', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _buildTestSlug: (test: Frameworks.Test) => string
    }

    const retriedTest = createTest({
      title: 'My Test Name!!!',
      fullTitle: 'suite My Test Name!!!',
      _currentRetry: 2,
    })

    const slugOne = service._buildTestSlug(retriedTest)
    const slugTwo = service._buildTestSlug(retriedTest)

    expect(slugOne).toBe(slugTwo)
    expect(slugOne).toMatch(/^my_test_name_[a-f0-9]{8}_retry2$/)

    const differentTest = createTest({
      title: 'My Test Name!!!',
      fullTitle: 'suite another title',
    })
    const differentSlug = service._buildTestSlug(differentTest)
    expect(slugOne).not.toBe(differentSlug)
  })

  it('buildTestSlug includes session token when available', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _sessionIdToken: string
      _buildTestSlug: (test: Frameworks.Test) => string
    }

    service._sessionIdToken = 'abc123def456'
    const testCase = createTest({
      title: 'My Test Name!!!',
      fullTitle: 'suite My Test Name!!!',
    })

    const slug = service._buildTestSlug(testCase)
    expect(slug).toMatch(/^my_test_name_abc123def456_[a-f0-9]{8}$/)
  })

  it('buildTestSlug keeps default test style scoped to the test title', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _buildTestSlug: (test: Frameworks.Test, context?: unknown) => string
    }

    const slug = service._buildTestSlug(
      createTest({
        title: 'adds item',
        fullTitle: 'cart suite adds item',
      }),
    )

    expect(slug).toMatch(/^adds_item_[a-f0-9]{8}$/)
  })

  it('buildTestSlug can prefer full test names when fileNameStyle is testFull', () => {
    const service = new WdioPuppeteerVideoService({
      fileNameStyle: 'testFull',
    }) as unknown as {
      _buildTestSlug: (test: Frameworks.Test, context?: unknown) => string
    }

    const slug = service._buildTestSlug(
      createTest({
        title: 'adds item',
        fullTitle: 'cart suite adds item',
      }),
    )

    expect(slug).toMatch(/^cart_suite_adds_item_[a-f0-9]{8}$/)
  })

  it('buildTestSlug derives a suite-aware testFull name from parent when fullTitle is unavailable', () => {
    const service = new WdioPuppeteerVideoService({
      fileNameStyle: 'testFull',
    }) as unknown as {
      _buildTestSlug: (test: Frameworks.Test, context?: unknown) => string
    }

    const slug = service._buildTestSlug(
      createTest({
        parent: 'Advanced E2E - Filename Style',
        title: 'unique title token should not appear for session style modes',
        fullTitle:
          'unique title token should not appear for session style modes',
        fullName: '',
      }),
    )

    expect(slug).toMatch(
      /^advanced_e2e_filename_style_unique_title_token_should_not_appear_for_session_style_modes_[a-f0-9]{8}$/,
    )
  })

  it('buildTestSlug falls back to fullName when title is generic', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _buildTestSlug: (test: Frameworks.Test, context?: unknown) => string
    }

    const slug = service._buildTestSlug(
      createTest({
        title: 'index',
        fullTitle: 'index',
        fullName: 'should support jasmine naming',
      }),
    )

    expect(slug).toMatch(/^should_support_jasmine_naming_[a-f0-9]{8}$/)
  })

  it('buildTestSlug can use cucumber pickle name from context', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _buildTestSlug: (test: Frameworks.Test, context?: unknown) => string
    }

    const slug = service._buildTestSlug(
      createTest({ title: 'index', fullTitle: '', fullName: '' }),
      {
        pickle: { name: 'user can check out successfully' },
      },
    )

    expect(slug).toMatch(/^user_can_check_out_successfully_[a-f0-9]{8}$/)
  })

  it('buildTestSlug supports full-session-only filename style', () => {
    const service = new WdioPuppeteerVideoService({
      fileNameStyle: 'sessionFull',
    }) as unknown as {
      _sessionIdToken: string
      _sessionIdFullToken: string
      _buildTestSlug: (test: Frameworks.Test, context?: unknown) => string
    }

    service._sessionIdToken = 'abc123def456'
    service._sessionIdFullToken = '550e8400_e29b_41d4_a716_446655440000'
    const slug = service._buildTestSlug(createTest({ title: 'ignored' }))

    expect(slug).toBe('550e8400_e29b_41d4_a716_446655440000')
  })

  it('buildTestSlug supports short-session-only filename style', () => {
    const service = new WdioPuppeteerVideoService({
      fileNameStyle: 'session',
    }) as unknown as {
      _sessionIdToken: string
      _buildTestSlug: (test: Frameworks.Test, context?: unknown) => string
    }

    service._sessionIdToken = 'abc123def456'
    const slug = service._buildTestSlug(createTest({ title: 'ignored' }))

    expect(slug).toBe('abc123def456')
  })

  it('buildTestSlug appends retry token for session-only filename style', () => {
    const service = new WdioPuppeteerVideoService({
      fileNameStyle: 'session',
    }) as unknown as {
      _sessionIdToken: string
      _buildTestSlug: (test: Frameworks.Test, context?: unknown) => string
    }

    service._sessionIdToken = 'abc123def456'
    const slug = service._buildTestSlug(
      createTest({ title: 'ignored', _currentRetry: 2 }),
    )

    expect(slug).toBe('abc123def456_retry2')
  })

  it('buildTestSlug keeps session/hash and a tiny title token when constrained', () => {
    const service = new WdioPuppeteerVideoService({
      maxFileNameLength: 30,
      fileNameOverflowStrategy: 'session',
    }) as unknown as {
      _sessionIdToken: string
      _buildTestSlug: (test: Frameworks.Test) => string
    }

    service._sessionIdToken = 'abc123def456'
    const slug = service._buildTestSlug(
      createTest({
        title:
          'this is a very long test title that should not be used when session overflow strategy is enabled and the filename budget is tiny',
      }),
    )

    expect(slug).toMatch(/^this_abc123def456_[a-f0-9]{8}$/)
  })

  it('buildTestSlug truncates title when constrained with truncate strategy', () => {
    const service = new WdioPuppeteerVideoService({
      maxFileNameLength: 40,
      fileNameOverflowStrategy: 'truncate',
    }) as unknown as {
      _sessionIdToken: string
      _buildTestSlug: (test: Frameworks.Test) => string
      _maxSlugLength: number
    }

    service._sessionIdToken = 'abc123def456'
    const slug = service._buildTestSlug(
      createTest({
        title:
          'this is a very long test title that should be truncated to respect the filename budget',
      }),
    )
    const maxSlugLength = service._maxSlugLength

    expect(slug).toMatch(/^this_[a-z0-9_]*abc123def456_[a-f0-9]{8}$/)
    expect(slug.length).toBeLessThanOrEqual(maxSlugLength)
  })

  it('before() logs a warning and continues when outputDir mkdir fails', async () => {
    await withTempDir(async (tempDir) => {
      // Block dir creation by placing a file where the dir should be
      const blockedOutputDir = path.join(tempDir, 'blocked-output')
      await fs.writeFile(blockedOutputDir, 'blocker')

      const service = new WdioPuppeteerVideoService({
        outputDir: blockedOutputDir,
      }) as unknown as {
        _log: (level: string, message: string) => void
        _recordingDisabledReason?: string
        _runSerializedRecordingTask: (
          task: () => Promise<void>,
        ) => Promise<void>
        before: (
          capabilities: WebdriverIO.Capabilities,
          specs: string[],
          browser: unknown,
        ) => Promise<void>
        beforeTest: (test: Frameworks.Test, context: unknown) => Promise<void>
      }

      const warnMessages: string[] = []
      service._log = (level, message) => {
        if (level === 'warn') {
          warnMessages.push(message)
        }
      }
      let serializedTaskRuns = 0
      service._runSerializedRecordingTask = async () => {
        serializedTaskRuns += 1
      }

      // The before() hook must resolve — never throw — even when mkdir rejects
      await expect(
        service.before({ browserName: 'chrome' }, ['tests/specs/e2e.test.ts'], {
          sessionId: 'abc123',
          capabilities: { browserName: 'chrome' },
        }),
      ).resolves.toBeUndefined()

      expect(
        warnMessages.some((m) =>
          m.includes('Failed to create output directory'),
        ),
      ).toBe(true)
      expect(service._recordingDisabledReason).toBe(
        'output directory is unavailable',
      )

      await service.beforeTest(createTest({ title: 'should skip' }), {})
      expect(serializedTaskRuns).toBe(0)
    })
  })

  it('_acquireRecordingSlotForStart logs the fastFail timeout when acquisition fails', async () => {
    const service = new WdioPuppeteerVideoService({
      recordingStartMode: 'fastFail',
      recordingStartTimeoutMs: 1234,
    }) as unknown as {
      _acquireRecordingSlotForStart: () => Promise<boolean>
      _log: (level: string, message: string) => void
      _recordingSlotScheduler: {
        acquire: () => Promise<boolean>
        release: () => Promise<void>
      }
    }

    const warnMessages: string[] = []
    service._recordingSlotScheduler = {
      acquire: async () => false,
      release: async () => {},
    }
    service._log = (level, message) => {
      if (level === 'warn') {
        warnMessages.push(message)
      }
    }

    await expect(service._acquireRecordingSlotForStart()).resolves.toBe(false)
    expect(warnMessages).toHaveLength(1)
    expect(warnMessages[0]).toContain('within 1234ms')
  })

  it('_createRecordingOutput warns once when direct mp4 capture may be incompatible', () => {
    const { service, warnMessages } = createRecordingOutputHarness(
      { outputFormat: 'mp4' },
      false,
    )

    expect(service._createRecordingOutput()).toEqual({
      outputFormat: 'mp4',
      outputPath: path.join('artifacts', 'capture_part1.mp4'),
      recordingFormat: 'mp4',
      recordingPath: path.join('artifacts', 'capture_part1.mp4'),
      transcodeEnabled: false,
    })
    expect(service._createRecordingOutput().recordingFormat).toBe('mp4')
    expect(warnMessages).toHaveLength(1)
    expect(warnMessages[0]).toContain('VP9-in-MP4 artifacts')
  })

  it('_createRecordingOutput switches capture to webm when transcode is enabled', () => {
    const { service, warnMessages } = createRecordingOutputHarness(
      { outputFormat: 'mp4' },
      true,
    )

    expect(service._createRecordingOutput()).toEqual({
      outputFormat: 'mp4',
      outputPath: path.join('artifacts', 'capture_part1.mp4'),
      recordingFormat: 'webm',
      recordingPath: path.join('artifacts', 'capture_part1.webm'),
      transcodeEnabled: true,
    })
    expect(warnMessages).toHaveLength(0)
  })

  it('_disableRecordingForWorker logs only once', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _captureSession: CaptureSession
      _canUseRecordingHooks: () => boolean
      _disableRecordingForWorker: (reason: string) => void
      _isChromium: boolean
      _log: (level: string, message: string) => void
    }

    const warnMessages: string[] = []
    service._captureSession.setBrowser({} as never)
    service._isChromium = true
    service._log = (level, message) => {
      if (level === 'warn') {
        warnMessages.push(message)
      }
    }

    expect(service._canUseRecordingHooks()).toBe(true)

    service._disableRecordingForWorker('worker disabled')
    service._disableRecordingForWorker('worker disabled again')

    expect(service._canUseRecordingHooks()).toBe(false)
    expect(
      warnMessages.filter((message) =>
        message.includes('Recording disabled for this worker'),
      ),
    ).toHaveLength(1)
  })

  it('_resetTestState clears recording state and releases held slots', async () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _captureSession: CaptureSession
      _recordingSlotScheduler: {
        acquire: () => Promise<boolean>
        release: () => Promise<void>
      }
      _resetTestState: () => Promise<void>
    }

    let releaseCalls = 0
    service._captureSession.beginRecording('active')
    service._captureSession.advanceSegment()
    service._captureSession.advanceSegment()
    service._captureSession.setWindowHandle('window-1')
    service._captureSession.addRecordedPath('segment.webm')
    service._recordingSlotScheduler = {
      acquire: async () => true,
      release: async () => {
        releaseCalls += 1
      },
    }

    expect(service._captureSession.isRecordingActive).toBe(true)
    await service._resetTestState()

    expect(service._captureSession.isRecordingActive).toBe(false)
    expect(service._captureSession.currentSegment).toBe(0)
    expect(service._captureSession.currentTestSlug).toBe('')
    expect(service._captureSession.currentWindowHandle).toBeUndefined()
    expect(service._captureSession.recordedPaths).toEqual([])
    expect(releaseCalls).toBe(1)
  })

  it('_deleteSegments removes all recorded segment files and clears the set', async () => {
    await withTempDir(async (tempDir) => {
      const seg1 = path.join(tempDir, 'slug_part1.webm')
      const seg2 = path.join(tempDir, 'slug_part2.webm')
      await fs.writeFile(seg1, 'data')
      await fs.writeFile(seg2, 'data')

      const service = new WdioPuppeteerVideoService({
        outputDir: tempDir,
      }) as unknown as {
        _captureSession: CaptureSession
        _deleteSegments: () => Promise<void>
      }

      service._captureSession.addRecordedPath(seg1)
      service._captureSession.addRecordedPath(seg2)

      await service._deleteSegments()

      expect(service._captureSession.recordedPaths).toEqual([])

      const seg1Exists = await fs
        .stat(seg1)
        .then(() => true)
        .catch(() => false)
      const seg2Exists = await fs
        .stat(seg2)
        .then(() => true)
        .catch(() => false)
      expect(seg1Exists).toBe(false)
      expect(seg2Exists).toBe(false)
    })
  })
})
