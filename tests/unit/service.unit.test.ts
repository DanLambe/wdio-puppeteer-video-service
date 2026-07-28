import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Frameworks } from '@wdio/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WdioPuppeteerVideoLauncher from '../../src/launcher.js'
import type { CaptureSession } from '../../src/service/capture-session.js'
import { CI_TRANSCODE_FFMPEG_ARGS } from '../../src/service/constants.js'
import * as ffmpeg from '../../src/service/ffmpeg.js'
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
  _log: (level: string, message: string) => void
  _shouldTranscode: () => boolean
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
  service._shouldTranscode = () => shouldTranscode
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

  it('shouldTranscode respects mp4 mode and transcode override', () => {
    const autoService = new WdioPuppeteerVideoService({
      outputFormat: 'mp4',
      mp4Mode: 'auto',
    }) as unknown as {
      _forceMp4Transcode: boolean
      _shouldTranscode: (outputFormat: 'webm' | 'mp4') => boolean
    }

    autoService._forceMp4Transcode = false
    expect(autoService._shouldTranscode('mp4')).toBe(false)
    autoService._forceMp4Transcode = true
    expect(autoService._shouldTranscode('mp4')).toBe(true)
    expect(autoService._shouldTranscode('webm')).toBe(false)

    const directService = new WdioPuppeteerVideoService({
      outputFormat: 'mp4',
      mp4Mode: 'direct',
    }) as unknown as {
      _forceMp4Transcode: boolean
      _shouldTranscode: (outputFormat: 'webm' | 'mp4') => boolean
    }
    directService._forceMp4Transcode = true
    expect(directService._shouldTranscode('mp4')).toBe(false)

    const transcodeService = new WdioPuppeteerVideoService({
      outputFormat: 'mp4',
      mp4Mode: 'transcode',
    }) as unknown as {
      _shouldTranscode: (outputFormat: 'webm' | 'mp4') => boolean
    }
    expect(transcodeService._shouldTranscode('mp4')).toBe(true)

    const overrideService = new WdioPuppeteerVideoService({
      outputFormat: 'mp4',
      mp4Mode: 'direct',
      transcode: { enabled: true },
    }) as unknown as {
      _shouldTranscode: (outputFormat: 'webm' | 'mp4') => boolean
    }
    expect(overrideService._shouldTranscode('mp4')).toBe(true)
  })

  it('configureMp4RecordingMode enables fallback in auto mode only', async () => {
    const probeDirectMp4Support = vi
      .spyOn(ffmpeg, 'probeDirectMp4Support')
      .mockResolvedValue(false)
    const autoService = new WdioPuppeteerVideoService({
      outputFormat: 'mp4',
      mp4Mode: 'auto',
    }) as unknown as {
      _forceMp4Transcode: boolean
      _resolveFfmpegPath: () => string
      _configureMp4RecordingMode: () => Promise<void>
    }

    autoService._resolveFfmpegPath = () => '/tmp/ffmpeg'
    await autoService._configureMp4RecordingMode()
    expect(autoService._forceMp4Transcode).toBe(true)

    const directService = new WdioPuppeteerVideoService({
      outputFormat: 'mp4',
      mp4Mode: 'direct',
    }) as unknown as {
      _forceMp4Transcode: boolean
      _resolveFfmpegPath: () => string
      _configureMp4RecordingMode: () => Promise<void>
    }
    directService._resolveFfmpegPath = () => '/tmp/ffmpeg'
    await directService._configureMp4RecordingMode()
    expect(directService._forceMp4Transcode).toBe(false)
    expect(probeDirectMp4Support).toHaveBeenCalledTimes(2)
  })

  it('configureMp4RecordingMode respects explicit transcode override', async () => {
    const service = new WdioPuppeteerVideoService({
      outputFormat: 'mp4',
      mp4Mode: 'auto',
      transcode: { enabled: true },
    }) as unknown as {
      _forceMp4Transcode: boolean
      _configureMp4RecordingMode: () => Promise<void>
    }

    service._forceMp4Transcode = false
    await service._configureMp4RecordingMode()
    expect(service._forceMp4Transcode).toBe(false)
  })

  it('before hook does not probe ffmpeg eagerly', async () => {
    const resolveAvailableFfmpegPath = vi.spyOn(
      ffmpeg,
      'resolveAvailableFfmpegPath',
    )
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _ffmpegInitializationCompleted: boolean
      before: (
        capabilities: WebdriverIO.Capabilities,
        specs: string[],
        browser: unknown,
      ) => Promise<void>
    }

    await service.before({}, ['tests/specs/e2e.test.ts'], {
      sessionId: 'abc123',
      capabilities: {
        browserName: 'chrome',
      },
    })

    expect(resolveAvailableFfmpegPath).not.toHaveBeenCalled()
    expect(service._ffmpegInitializationCompleted).toBe(false)
  })

  it('lazy ffmpeg probe runs only when retry recording actually starts', async () => {
    const resolveAvailableFfmpegPath = vi
      .spyOn(ffmpeg, 'resolveAvailableFfmpegPath')
      .mockResolvedValue('/tmp/ffmpeg')
    vi.spyOn(ffmpeg, 'probeDirectMp4Support').mockResolvedValue(true)
    const service = new WdioPuppeteerVideoService({
      recordOnRetries: true,
    }) as unknown as {
      _captureSession: CaptureSession
      _isChromium: boolean
      _runSerializedRecordingTask: (task: () => Promise<void>) => Promise<void>
      beforeTest: (test: Frameworks.Test, context: unknown) => Promise<void>
      _startRecording: () => Promise<boolean>
      _ensureFfmpegReady: () => Promise<boolean>
    }

    service._isChromium = true
    service._captureSession.setBrowser({} as never)
    service._runSerializedRecordingTask = async (task) => {
      await task()
    }

    service._startRecording = async () => service._ensureFfmpegReady()

    await service.beforeTest(createTest({ title: 'retry lazy probe' }), {})
    expect(resolveAvailableFfmpegPath).not.toHaveBeenCalled()

    await service.beforeTest(
      createTest({
        title: 'retry lazy probe',
        _currentRetry: 1,
      }),
      {},
    )
    expect(resolveAvailableFfmpegPath).toHaveBeenCalledOnce()

    service._captureSession.resetRecording()
    await service.beforeTest(
      createTest({
        title: 'retry lazy probe',
        _currentRetry: 2,
      }),
      {},
    )
    expect(resolveAvailableFfmpegPath).toHaveBeenCalledOnce()
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
      _ffmpegAvailable: boolean
      _runSerializedRecordingTask: (task: () => Promise<void>) => Promise<void>
      beforeCommand: (commandName: string) => Promise<void>
      afterCommand: (commandName: string) => Promise<void>
    }

    service._isChromium = true
    service._ffmpegAvailable = true
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
      _ensureFfmpegReady: () => Promise<boolean>
      _recordingSlotScheduler: {
        acquire: () => Promise<boolean>
        release: () => Promise<void>
      }
      _startRecording: () => Promise<boolean>
    }

    service._captureSession.setBrowser({} as never)
    service._captureSession.beginRecording('slot-order')
    service._captureEngine.startCapture = startCapture
    service._ensureFfmpegReady = async () => true
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
      _ensureFfmpegReady: () => Promise<boolean>
      _recordingSlotScheduler: {
        acquire: () => Promise<boolean>
        release: () => Promise<void>
      }
      _startRecording: () => Promise<boolean>
    }

    service._captureSession.setBrowser({} as never)
    service._captureSession.beginRecording('slot-release')
    service._captureEngine.startCapture = startCapture
    service._ensureFfmpegReady = async () => true
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

  it('createResolvedTranscodeOptions preserves deleteOriginal and ffmpegArgs', () => {
    const service = new WdioPuppeteerVideoService({
      performanceProfile: 'ci',
      transcode: {
        deleteOriginal: false,
        ffmpegArgs: ['-preset', 'slow'],
      },
    }) as unknown as {
      _createResolvedTranscodeOptions: () => {
        deleteOriginal: boolean
        ffmpegArgs?: string[]
      }
    }

    expect(service._createResolvedTranscodeOptions()).toEqual({
      deleteOriginal: false,
      ffmpegArgs: ['-preset', 'slow'],
    })
  })

  it('createResolvedTranscodeOptions uses conservative CI defaults when args are unset', () => {
    const service = new WdioPuppeteerVideoService({
      performanceProfile: 'ci',
    }) as unknown as {
      _createResolvedTranscodeOptions: () => {
        deleteOriginal: boolean
        ffmpegArgs?: string[]
      }
    }

    expect(service._createResolvedTranscodeOptions()).toEqual({
      deleteOriginal: true,
      ffmpegArgs: [...CI_TRANSCODE_FFMPEG_ARGS],
    })
  })

  it('createResolvedTranscodeOptions lets an explicit empty array opt out of CI defaults', () => {
    const service = new WdioPuppeteerVideoService({
      performanceProfile: 'ci',
      transcode: {
        ffmpegArgs: [],
      },
    }) as unknown as {
      _createResolvedTranscodeOptions: () => {
        deleteOriginal: boolean
        ffmpegArgs?: string[]
      }
    }

    expect(service._createResolvedTranscodeOptions()).toEqual({
      deleteOriginal: true,
      ffmpegArgs: [],
    })
  })

  it('transcodeToH264Mp4WithArgs removes partial output after failure', async () => {
    await withTempDir(async (tempDir) => {
      const inputPath = path.join(tempDir, 'input.webm')
      const outputPath = path.join(tempDir, 'output.mp4')
      await fs.writeFile(inputPath, 'source', 'utf8')

      const service = new WdioPuppeteerVideoService() as unknown as {
        _runFfmpeg: (args: string[]) => Promise<boolean>
        _transcodeToH264Mp4WithArgs: (
          inputPath: string,
          outputPath: string,
          ffmpegArgs: string[] | undefined,
        ) => Promise<string | undefined>
      }
      service._runFfmpeg = async (args) => {
        const temporaryPath = args.at(-1)
        if (temporaryPath) {
          await fs.writeFile(temporaryPath, 'partial', 'utf8')
        }
        return false
      }

      await expect(
        service._transcodeToH264Mp4WithArgs(inputPath, outputPath, undefined),
      ).resolves.toBeUndefined()
      await expect(fs.stat(outputPath)).rejects.toThrow()
      await expect(fs.readFile(inputPath, 'utf8')).resolves.toBe('source')
    })
  })

  it('applies error failure policy only after preserving media and releasing post-processing capacity', async () => {
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
        _postProcessSlotScheduler: {
          ownsPostProcessSlot: boolean
        }
        _captureSession: CaptureSession
        _runFfmpeg: () => Promise<boolean>
      }
      service._runFfmpeg = async () => false

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

      expect(service._captureSession.recordedPaths).toContain(inputPath)
      expect(service._postProcessSlotScheduler.ownsPostProcessSlot).toBe(false)
      await expect(fs.readFile(inputPath, 'utf8')).resolves.toBe('source-media')
      await expect(fs.stat(outputPath)).rejects.toThrow()
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
        _transcodeToH264Mp4WithArgs: (
          inPath: string,
          outPath: string,
          ffmpegArgs: string[] | undefined,
        ) => Promise<boolean>
        _flushDeferredPostProcessTasks: () => Promise<void>
      }

      const seenCalls: Array<{
        inPath: string
        outPath: string
        ffmpegArgs: string[] | undefined
      }> = []
      service._deferredPostProcessTasks.push({
        kind: 'transcode',
        inputPath,
        outputPath,
        deleteOriginal: false,
      })
      service._transcodeToH264Mp4WithArgs = async (
        inPath,
        outPath,
        ffmpegArgs,
      ) => {
        seenCalls.push({
          inPath,
          outPath,
          ffmpegArgs,
        })
        return true
      }

      await service._flushDeferredPostProcessTasks()

      expect(seenCalls).toEqual([
        {
          inPath: inputPath,
          outPath: outputPath,
          ffmpegArgs: undefined,
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

  it('executeDeferredTranscodeTask skips missing inputs and deletes originals after success', async () => {
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
        _transcodeToH264Mp4WithArgs: (
          inputPath: string,
          outputPath: string,
          ffmpegArgs: string[] | undefined,
        ) => Promise<boolean>
      }

      let transcodeCalls = 0
      service._transcodeToH264Mp4WithArgs = async () => {
        transcodeCalls += 1
        return true
      }

      await service._executeDeferredTranscodeTask({
        kind: 'transcode',
        inputPath,
        outputPath,
        deleteOriginal: true,
      })
      expect(transcodeCalls).toBe(0)

      await fs.writeFile(inputPath, 'source', 'utf8')
      await service._executeDeferredTranscodeTask({
        kind: 'transcode',
        inputPath,
        outputPath,
        deleteOriginal: true,
        ffmpegArgs: ['-preset', 'slow'],
      })

      expect(transcodeCalls).toBe(1)
      await expect(fs.stat(inputPath)).rejects.toThrow()
    })
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
      _mergeSegmentPathsToOutput: () => Promise<string | undefined>
    }

    const transcodeTasks: Array<{
      kind: 'transcode'
      inputPath: string
      outputPath: string
      deleteOriginal: boolean
      ffmpegArgs?: string[]
    }> = []
    service._mergeSegmentPathsToOutput = async () => 'merged.webm'
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

  it('ffmpeg path resolution prefers explicit option', () => {
    const service = new WdioPuppeteerVideoService({
      ffmpegPath: '/custom/ffmpeg',
    }) as unknown as {
      _resolveFfmpegPath: () => string
    }

    expect(service._resolveFfmpegPath()).toBe('/custom/ffmpeg')
  })

  it('ffmpeg path resolution prefers discovered binary when available', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _resolvedFfmpegPath?: string
      _resolveFfmpegPath: () => string
    }

    service._resolvedFfmpegPath = '/detected/ffmpeg'
    expect(service._resolveFfmpegPath()).toBe('/detected/ffmpeg')
  })

  it('ffmpeg path resolution uses FFMPEG_PATH when option is unset', () => {
    const previousFfmpegPath = process.env.FFMPEG_PATH
    try {
      process.env.FFMPEG_PATH = '/env/ffmpeg'

      const service = new WdioPuppeteerVideoService({}) as unknown as {
        _resolveFfmpegPath: () => string
      }
      expect(service._resolveFfmpegPath()).toBe('/env/ffmpeg')
    } finally {
      process.env.FFMPEG_PATH = previousFfmpegPath
    }
  })

  it('ffmpeg path defaults to PATH lookup when no override exists', () => {
    const previousFfmpegPath = process.env.FFMPEG_PATH
    try {
      delete process.env.FFMPEG_PATH

      const service = new WdioPuppeteerVideoService({}) as unknown as {
        _resolveFfmpegPath: () => string
      }
      expect(service._resolveFfmpegPath()).toBe('ffmpeg')
    } finally {
      process.env.FFMPEG_PATH = previousFfmpegPath
    }
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

  it('_warnMissingFfmpeg and _disableRecordingForWorker only log once', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _captureSession: CaptureSession
      _canUseRecordingHooks: () => boolean
      _disableRecordingForWorker: (reason: string) => void
      _isChromium: boolean
      _log: (level: string, message: string) => void
      _warnMissingFfmpeg: (reason: string) => void
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

    service._warnMissingFfmpeg('ffmpeg missing')
    service._warnMissingFfmpeg('ffmpeg missing again')
    service._disableRecordingForWorker('worker disabled')
    service._disableRecordingForWorker('worker disabled again')

    expect(service._canUseRecordingHooks()).toBe(false)
    expect(
      warnMessages.filter((message) => message.includes('ffmpeg')),
    ).toHaveLength(1)
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
