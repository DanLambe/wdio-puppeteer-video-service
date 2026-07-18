import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Frameworks } from '@wdio/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CI_TRANSCODE_FFMPEG_ARGS } from '../../src/service/constants.js'
import * as ffmpeg from '../../src/service/ffmpeg.js'
import * as pageLookup from '../../src/service/page-lookup.js'
import * as retryState from '../../src/service/retry-state.js'
import WdioPuppeteerVideoService from '../../src/service.js'
import type { WdioPuppeteerVideoServiceOptions } from '../../src/types.js'

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
  ) => Promise<void>
  onWorkerEnd: (
    cid: string,
    exitCode: number,
    specs: string[],
    retries: number,
  ) => Promise<void>
  onComplete: () => Promise<void>
}

type RetryWorkerService = {
  _isChromium: boolean
  _ffmpegAvailable: boolean
  _browser: unknown
  _runSerializedRecordingTask: (task: () => Promise<void>) => Promise<void>
  _startRecordingForEntity: (
    test: Frameworks.Test,
    context: unknown,
    retryCount: number,
  ) => Promise<void>
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
  _createRecordingOutput: () => RecordingOutput
  _currentSegment: number
  _currentTestSlug: string
  _log: (level: string, message: string) => void
  _shouldTranscode: () => boolean
}

const createRecordingOutputHarness = (
  options: WdioPuppeteerVideoServiceOptions,
  shouldTranscode: boolean,
): { service: RecordingOutputService; warnMessages: string[] } => {
  const service = new WdioPuppeteerVideoService({
    outputDir: 'artifacts',
    ...options,
  }) as unknown as RecordingOutputService
  const warnMessages: string[] = []
  service._currentSegment = 1
  service._currentTestSlug = 'capture'
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
  return new WdioPuppeteerVideoService({
    outputDir,
    recordOnRetries: true,
  })
}

const primeRetryStateForSecondWorker = async (
  launcherService: RetryLauncherService,
  launcherCapabilities: WebdriverIO.Capabilities,
  specs: string[],
): Promise<void> => {
  await launcherService.onPrepare()
  await launcherService.onWorkerStart('0-0', launcherCapabilities, specs)
  await launcherService.onWorkerEnd('0-0', 1, specs, 0)
  await launcherService.onWorkerStart('0-1', launcherCapabilities, specs)
}

const createRetryWorkerHarness = (
  outputDir: string,
): { workerService: RetryWorkerService; seenRetryCounts: number[] } => {
  const workerService = new WdioPuppeteerVideoService({
    outputDir,
    recordOnRetries: true,
  }) as unknown as RetryWorkerService

  workerService._isChromium = true
  workerService._ffmpegAvailable = true
  workerService._browser = {}
  workerService._runSerializedRecordingTask = async (task) => {
    await task()
  }

  const seenRetryCounts: number[] = []
  workerService._startRecordingForEntity = async (
    _test,
    _context,
    retryCount,
  ) => {
    seenRetryCounts.push(retryCount)
  }

  return {
    workerService,
    seenRetryCounts,
  }
}

const runSpecFileRetryBeforeTest = async (
  workerService: RetryWorkerService,
  workerCapabilities: WebdriverIO.Capabilities,
  specs: string[],
): Promise<void> => {
  const specPath = specs[0] ?? RETRY_RECORDING_SPEC_PATH
  await workerService.beforeSession({}, workerCapabilities, specs, '0-1')
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

  it('constructor applies stable defaults and normalizes invalid numbers', () => {
    const service = new WdioPuppeteerVideoService({
      outputDir: '   ',
      videoWidth: 0,
      videoHeight: -10,
      fps: Number.NaN,
      outputFormat: 'mp4',
    }) as unknown as {
      _options: {
        outputDir: string
        videoWidth: number
        videoHeight: number
        fps: number
        outputFormat?: 'webm' | 'mp4'
        mp4Mode?: string
        maxFileNameLength?: number
        fileNameStyle?: string
        fileNameOverflowStrategy?: string
        performanceProfile?: string
        recordOnRetries?: boolean
        specLevelRecording?: boolean
        skipViewPortKickoff?: boolean
        segmentOnWindowSwitch?: boolean
        maxConcurrentRecordings?: number
        maxGlobalRecordings?: number
        recordingStartMode?: string
        recordingStartTimeoutMs?: number
        ffmpegTimeoutMs?: number
        globalRecordingLockDir?: string
        postProcessMode?: string
        includeSpecPatterns?: string[]
        excludeSpecPatterns?: string[]
        includeTagPatterns?: string[]
        excludeTagPatterns?: string[]
        transcode?: { deleteOriginal?: boolean }
        mergeSegments?: { deleteSegments?: boolean; enabled?: boolean }
      }
      _logLevel: string
    }

    expect(service._options.outputDir).toBe('videos')
    expect(service._options.videoWidth).toBe(1280)
    expect(service._options.videoHeight).toBe(720)
    expect(service._options.fps).toBe(30)
    expect(service._options.maxFileNameLength).toBeGreaterThanOrEqual(40)
    expect(service._options.fileNameStyle).toBe('test')
    expect(service._options.fileNameOverflowStrategy).toBe('truncate')
    expect(service._options.mp4Mode).toBe('auto')
    expect(service._options.performanceProfile).toBe('default')
    expect(service._options.recordOnRetries).toBe(false)
    expect(service._options.specLevelRecording).toBe(false)
    expect(service._options.skipViewPortKickoff).toBe(false)
    expect(service._options.segmentOnWindowSwitch).toBe(true)
    expect(service._options.maxConcurrentRecordings).toBe(0)
    expect(service._options.maxGlobalRecordings).toBe(0)
    expect(service._options.recordingStartMode).toBe('blocking')
    expect(service._options.recordingStartTimeoutMs).toBe(2500)
    expect(service._options.ffmpegTimeoutMs).toBe(0)
    expect(service._options.globalRecordingLockDir).toBeUndefined()
    expect(service._options.postProcessMode).toBe('immediate')
    expect(service._options.includeSpecPatterns).toEqual([])
    expect(service._options.excludeSpecPatterns).toEqual([])
    expect(service._options.includeTagPatterns).toEqual([])
    expect(service._options.excludeTagPatterns).toEqual([])
    expect(service._options.transcode?.deleteOriginal).toBe(true)
    expect(service._options.mergeSegments?.deleteSegments).toBe(true)
    expect(service._logLevel).toBe('warn')
  })

  it('constructor supports omitted options', () => {
    const service = new WdioPuppeteerVideoService() as unknown as {
      _options: {
        outputDir?: string
        outputFormat?: 'webm' | 'mp4'
        transcode?: { deleteOriginal?: boolean }
        mergeSegments?: { deleteSegments?: boolean }
      }
    }

    expect(service._options.outputDir).toBe('videos')
    expect(service._options.outputFormat).toBe('webm')
    expect(service._options.transcode?.deleteOriginal).toBe(true)
    expect(service._options.mergeSegments?.deleteSegments).toBe(true)
  })

  it('constructor defensively normalizes invalid runtime option values', () => {
    const service = new WdioPuppeteerVideoService({
      outputFormat: 'avi',
      ffmpegTimeoutMs: -1,
      transcode: {
        enabled: 'yes',
        deleteOriginal: 'no',
        ffmpegArgs: ['-crf', 28, '-preset'],
      },
      mergeSegments: {
        enabled: 'true',
        deleteSegments: 'no',
      },
    } as never) as unknown as {
      _options: {
        outputFormat?: 'webm' | 'mp4'
        ffmpegTimeoutMs?: number
        transcode?: {
          enabled?: boolean
          deleteOriginal?: boolean
          ffmpegArgs?: string[]
        }
        mergeSegments?: {
          enabled?: boolean
          deleteSegments?: boolean
        }
      }
    }

    expect(service._options.outputFormat).toBe('webm')
    expect(service._options.ffmpegTimeoutMs).toBe(0)
    expect(service._options.transcode).toEqual({
      deleteOriginal: true,
      ffmpegArgs: ['-crf', '-preset'],
    })
    expect(service._options.mergeSegments).toEqual({
      deleteSegments: true,
    })
  })

  it('parallel performance profile applies conservative defaults', () => {
    const service = new WdioPuppeteerVideoService({
      performanceProfile: 'parallel',
    }) as unknown as {
      _options: {
        videoWidth: number
        videoHeight: number
        fps: number
        outputFormat?: 'webm' | 'mp4'
        mp4Mode?: string
        performanceProfile?: string
        mergeSegments?: { enabled?: boolean; deleteSegments?: boolean }
      }
    }

    expect(service._options.performanceProfile).toBe('parallel')
    expect(service._options.videoWidth).toBe(1280)
    expect(service._options.videoHeight).toBe(720)
    expect(service._options.fps).toBe(24)
    expect(service._options.outputFormat).toBe('webm')
    expect(service._options.mp4Mode).toBe('auto')
    expect(service._options.mergeSegments?.enabled).toBe(false)
    expect(service._options.mergeSegments?.deleteSegments).toBe(true)
  })

  it('parallel performance profile does not override explicit values', () => {
    const service = new WdioPuppeteerVideoService({
      performanceProfile: 'parallel',
      videoWidth: 1920,
      videoHeight: 1080,
      fps: 30,
      outputFormat: 'mp4',
      mp4Mode: 'direct',
      mergeSegments: {
        enabled: true,
        deleteSegments: false,
      },
    }) as unknown as {
      _options: {
        videoWidth: number
        videoHeight: number
        fps: number
        outputFormat?: 'webm' | 'mp4'
        mp4Mode?: string
        mergeSegments?: { enabled?: boolean; deleteSegments?: boolean }
      }
    }

    expect(service._options.videoWidth).toBe(1920)
    expect(service._options.videoHeight).toBe(1080)
    expect(service._options.fps).toBe(30)
    expect(service._options.outputFormat).toBe('mp4')
    expect(service._options.mp4Mode).toBe('direct')
    expect(service._options.mergeSegments?.enabled).toBe(true)
    expect(service._options.mergeSegments?.deleteSegments).toBe(false)
  })

  it('ci performance profile applies conservative defaults', () => {
    const service = new WdioPuppeteerVideoService({
      performanceProfile: 'ci',
    }) as unknown as {
      _options: {
        videoWidth: number
        videoHeight: number
        fps: number
        outputFormat?: 'webm' | 'mp4'
        performanceProfile?: string
        skipViewPortKickoff?: boolean
        segmentOnWindowSwitch?: boolean
        postProcessMode?: string
        recordingStartMode?: string
        recordingStartTimeoutMs?: number
        mergeSegments?: { enabled?: boolean; deleteSegments?: boolean }
      }
      _logLevel: string
      _hasExplicitLogLevel: boolean
    }

    expect(service._options.performanceProfile).toBe('ci')
    expect(service._options.videoWidth).toBe(1280)
    expect(service._options.videoHeight).toBe(720)
    expect(service._options.fps).toBe(24)
    expect(service._options.outputFormat).toBe('webm')
    expect(service._options.skipViewPortKickoff).toBe(true)
    expect(service._options.segmentOnWindowSwitch).toBe(false)
    expect(service._options.postProcessMode).toBe('deferred')
    expect(service._options.recordingStartMode).toBe('fastFail')
    expect(service._options.recordingStartTimeoutMs).toBe(2500)
    expect(service._options.mergeSegments?.enabled).toBe(false)
    expect(service._logLevel).toBe('warn')
    expect(service._hasExplicitLogLevel).toBe(true)
  })

  it('ci performance profile does not override explicit values', () => {
    const service = new WdioPuppeteerVideoService({
      performanceProfile: 'ci',
      outputFormat: 'mp4',
      videoWidth: 1920,
      videoHeight: 1080,
      fps: 30,
      skipViewPortKickoff: false,
      segmentOnWindowSwitch: true,
      postProcessMode: 'immediate',
      recordingStartMode: 'blocking',
      recordingStartTimeoutMs: 5000,
      mergeSegments: {
        enabled: true,
      },
      logLevel: 'error',
    }) as unknown as {
      _options: {
        videoWidth: number
        videoHeight: number
        fps: number
        outputFormat?: 'webm' | 'mp4'
        skipViewPortKickoff?: boolean
        segmentOnWindowSwitch?: boolean
        postProcessMode?: string
        recordingStartMode?: string
        recordingStartTimeoutMs?: number
        mergeSegments?: { enabled?: boolean }
      }
      _logLevel: string
    }

    expect(service._options.videoWidth).toBe(1920)
    expect(service._options.videoHeight).toBe(1080)
    expect(service._options.fps).toBe(30)
    expect(service._options.outputFormat).toBe('mp4')
    expect(service._options.skipViewPortKickoff).toBe(false)
    expect(service._options.segmentOnWindowSwitch).toBe(true)
    expect(service._options.postProcessMode).toBe('immediate')
    expect(service._options.recordingStartMode).toBe('blocking')
    expect(service._options.recordingStartTimeoutMs).toBe(5000)
    expect(service._options.mergeSegments?.enabled).toBe(true)
    expect(service._logLevel).toBe('error')
  })

  it('constructor honors explicit service logLevel', () => {
    const service = new WdioPuppeteerVideoService({
      logLevel: 'silent',
    }) as unknown as {
      _logLevel: string
    }

    expect(service._logLevel).toBe('silent')
  })

  it('normalizes deferred post processing mode and filter pattern lists', () => {
    const service = new WdioPuppeteerVideoService({
      postProcessMode: 'deferred',
      includeSpecPatterns: ['  TESTS/ADVANCED/*  ', 'tests/advanced/*', ''],
      excludeSpecPatterns: ['  legacy  '],
      includeTagPatterns: [' @Smoke ', '@smoke', '@video*'],
      excludeTagPatterns: [' @skip '],
      globalRecordingLockDir: '   custom-lock-dir   ',
    }) as unknown as {
      _options: {
        postProcessMode?: string
        includeSpecPatterns?: string[]
        excludeSpecPatterns?: string[]
        includeTagPatterns?: string[]
        excludeTagPatterns?: string[]
        globalRecordingLockDir?: string
      }
    }

    expect(service._options.postProcessMode).toBe('deferred')
    expect(service._options.includeSpecPatterns).toEqual(['tests/advanced/*'])
    expect(service._options.excludeSpecPatterns).toEqual(['legacy'])
    expect(service._options.includeTagPatterns).toEqual(['@smoke', '@video*'])
    expect(service._options.excludeTagPatterns).toEqual(['@skip'])
    expect(service._options.globalRecordingLockDir).toBe('custom-lock-dir')
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
      _isChromium: boolean
      _browser: unknown
      _currentTestSlug: string
      _runSerializedRecordingTask: (task: () => Promise<void>) => Promise<void>
      beforeTest: (test: Frameworks.Test, context: unknown) => Promise<void>
      _startRecording: () => Promise<boolean>
      _ensureFfmpegReady: () => Promise<boolean>
    }

    service._isChromium = true
    service._browser = {}
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

    service._currentTestSlug = ''
    await service.beforeTest(
      createTest({
        title: 'retry lazy probe',
        _currentRetry: 2,
      }),
      {},
    )
    expect(resolveAvailableFfmpegPath).toHaveBeenCalledOnce()
  })

  it('startRecordingForEntity clears active state when recording start fails', async () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _currentTestSlug: string
      _currentSegment: number
      _startRecording: () => Promise<boolean>
      _startRecordingForEntity: (
        test: Frameworks.Test,
        context: unknown,
        retryCount: number,
      ) => Promise<void>
    }

    service._startRecording = async () => false

    await service._startRecordingForEntity(
      createTest({ title: 'failed start reset' }),
      {},
      0,
    )

    expect(service._currentTestSlug).toBe('')
    expect(service._currentSegment).toBe(0)
  })

  it('recordOnRetries starts test recording only on retry attempts', async () => {
    const service = new WdioPuppeteerVideoService({
      recordOnRetries: true,
    }) as unknown as {
      _isChromium: boolean
      _ffmpegAvailable: boolean
      _browser: unknown
      _runSerializedRecordingTask: (task: () => Promise<void>) => Promise<void>
      _startRecordingForEntity: (
        test: Frameworks.Test,
        context: unknown,
        retryCount: number,
      ) => Promise<void>
      beforeTest: (test: Frameworks.Test, context: unknown) => Promise<void>
    }

    service._isChromium = true
    service._ffmpegAvailable = true
    service._browser = {}
    service._runSerializedRecordingTask = async (task) => {
      await task()
    }

    const seenRetryCounts: number[] = []
    service._startRecordingForEntity = async (_test, _context, retryCount) => {
      seenRetryCounts.push(retryCount)
    }

    await service.beforeTest(createTest({ title: 'retry candidate' }), {})
    await service.beforeTest(
      createTest({
        title: 'retry candidate',
        _currentRetry: 1,
      }),
      {},
    )

    expect(seenRetryCounts).toEqual([1])
  })

  it('recordOnRetries works for cucumber when explicit retry count is absent', async () => {
    const service = new WdioPuppeteerVideoService({
      recordOnRetries: true,
    }) as unknown as {
      _isChromium: boolean
      _ffmpegAvailable: boolean
      _browser: unknown
      _runSerializedRecordingTask: (task: () => Promise<void>) => Promise<void>
      _startRecordingForEntity: (
        test: Frameworks.Test,
        context: unknown,
        retryCount: number,
      ) => Promise<void>
      beforeScenario: (
        world: Frameworks.World,
        context: unknown,
      ) => Promise<void>
    }

    service._isChromium = true
    service._ffmpegAvailable = true
    service._browser = {}
    service._runSerializedRecordingTask = async (task) => {
      await task()
    }

    const seenRetryCounts: number[] = []
    service._startRecordingForEntity = async (_test, _context, retryCount) => {
      seenRetryCounts.push(retryCount)
    }

    const world = {
      pickle: {
        name: 'user retries checkout',
      },
    } as Frameworks.World

    await service.beforeScenario(world, { uri: 'tests/features/retry.feature' })
    await service.beforeScenario(world, { uri: 'tests/features/retry.feature' })

    expect(seenRetryCounts).toEqual([1])
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
      await primeRetryStateForSecondWorker(
        launcherService,
        launcherCapabilities,
        specs,
      )

      const { workerService, seenRetryCounts } =
        createRetryWorkerHarness(tempDir)
      await runSpecFileRetryBeforeTest(workerService, workerCapabilities, specs)

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
      await primeRetryStateForSecondWorker(
        launcherService,
        launcherCapabilities,
        specs,
      )

      const { workerService, seenRetryCounts } =
        createRetryWorkerHarness(tempDir)
      await runSpecFileRetryBeforeTest(workerService, workerCapabilities, specs)

      expect(seenRetryCounts).toEqual([])
      await launcherService.onComplete()
    })
  })

  it('retry decision logging builds messages only when level is enabled', () => {
    const service = new WdioPuppeteerVideoService({
      recordOnRetries: true,
      logLevel: 'warn',
    }) as unknown as {
      _logLevel: string
      _log: (level: string, message: string, details?: unknown) => void
      _logRetryDecision: (
        retryContext: {
          explicitFrameworkRetry: number | undefined
          specFileRetryAttempt: number
          inferredEntityRetry: number | undefined
          effectiveRetryCount: number
        },
        entityLabel: string,
        shouldRecord: boolean,
      ) => void
      _logRetrySkip: (
        retryContext: {
          explicitFrameworkRetry: number | undefined
          specFileRetryAttempt: number
          inferredEntityRetry: number | undefined
          effectiveRetryCount: number
        },
        entityLabel: string,
      ) => void
    }

    let logCalls = 0
    service._log = () => {
      logCalls += 1
    }

    const retryContext = {
      explicitFrameworkRetry: 0,
      specFileRetryAttempt: 0,
      inferredEntityRetry: 0,
      effectiveRetryCount: 0,
    }
    service._logRetryDecision(retryContext, 'entity', false)
    service._logRetrySkip(retryContext, 'entity')
    expect(logCalls).toBe(0)

    service._logLevel = 'trace'
    service._logRetryDecision(retryContext, 'entity', true)
    expect(logCalls).toBe(1)

    service._logLevel = 'debug'
    service._logRetrySkip(retryContext, 'entity')
    expect(logCalls).toBe(2)
  })

  it('shouldRecordForFilters supports spec and tag include/exclude rules', () => {
    const specFilterService = new WdioPuppeteerVideoService({
      includeSpecPatterns: ['*advanced/specs*'],
      excludeSpecPatterns: ['*skip*'],
    }) as unknown as {
      _shouldRecordForFilters: (
        test: Frameworks.Test,
        context: unknown,
      ) => boolean
    }

    expect(
      specFilterService._shouldRecordForFilters(
        createTest({
          file: 'tests/advanced/specs/filter-spec-recording.spec.ts',
        }),
        {},
      ),
    ).toBe(true)
    expect(
      specFilterService._shouldRecordForFilters(
        createTest({
          file: 'tests/specs/e2e.test.ts',
        }),
        {},
      ),
    ).toBe(false)
    expect(
      specFilterService._shouldRecordForFilters(
        createTest({
          file: 'tests/advanced/specs/skip-this.spec.ts',
        }),
        {},
      ),
    ).toBe(false)

    const tagFilterService = new WdioPuppeteerVideoService({
      includeTagPatterns: ['@smoke*'],
      excludeTagPatterns: ['@skip*'],
    }) as unknown as {
      _shouldRecordForFilters: (
        test: Frameworks.Test,
        context: unknown,
      ) => boolean
    }

    expect(
      tagFilterService._shouldRecordForFilters(createTest(), {
        pickle: {
          tags: [{ name: '@SmokeCheckout' }],
        },
      }),
    ).toBe(true)
    expect(
      tagFilterService._shouldRecordForFilters(createTest(), {
        pickle: {
          tags: [{ name: '@skipVideo' }],
        },
      }),
    ).toBe(false)
  })

  it('specLevelRecording starts once and finalizes once with aggregated result', async () => {
    const service = new WdioPuppeteerVideoService({
      specLevelRecording: true,
    }) as unknown as {
      _isChromium: boolean
      _ffmpegAvailable: boolean
      _browser: unknown
      _runSerializedRecordingTask: (task: () => Promise<void>) => Promise<void>
      _startSpecLevelRecording: (retryCount: number) => Promise<void>
      _finalizeCurrentTestRecording: (passed: boolean) => Promise<void>
      _currentTestSlug: string
      beforeTest: (test: Frameworks.Test, context: unknown) => Promise<void>
      afterTest: (
        test: Frameworks.Test,
        context: unknown,
        result: Frameworks.TestResult,
      ) => Promise<void>
      after: () => Promise<void>
    }

    service._isChromium = true
    service._ffmpegAvailable = true
    service._browser = {}
    service._runSerializedRecordingTask = async (task) => {
      await task()
    }

    let startCount = 0
    service._startSpecLevelRecording = async () => {
      startCount += 1
      service._currentTestSlug = 'spec_level_slug'
    }

    const finalizedStatuses: boolean[] = []
    service._finalizeCurrentTestRecording = async (passed) => {
      finalizedStatuses.push(passed)
    }

    await service.beforeTest(createTest({ title: 'first spec test' }), {})
    await service.beforeTest(createTest({ title: 'second spec test' }), {})
    await service.afterTest(
      createTest({ title: 'first spec test' }),
      {},
      {
        passed: false,
        duration: 100,
        retries: { attempts: 0, limit: 0 },
        exception: '',
        status: 'failed',
      },
    )
    await service.after()

    expect(startCount).toBe(1)
    expect(finalizedStatuses).toEqual([false])
  })

  it('specLevelRecording with recordOnRetries waits until retry attempt before start', async () => {
    const service = new WdioPuppeteerVideoService({
      specLevelRecording: true,
      recordOnRetries: true,
    }) as unknown as {
      _isChromium: boolean
      _ffmpegAvailable: boolean
      _browser: unknown
      _runSerializedRecordingTask: (task: () => Promise<void>) => Promise<void>
      _startSpecLevelRecording: (retryCount: number) => Promise<void>
      beforeTest: (test: Frameworks.Test, context: unknown) => Promise<void>
    }

    service._isChromium = true
    service._ffmpegAvailable = true
    service._browser = {}
    service._runSerializedRecordingTask = async (task) => {
      await task()
    }

    const seenRetryCounts: number[] = []
    service._startSpecLevelRecording = async (retryCount) => {
      seenRetryCounts.push(retryCount)
    }

    await service.beforeTest(createTest({ title: 'spec retry case' }), {})
    await service.beforeTest(createTest({ title: 'spec retry case' }), {})

    expect(seenRetryCounts).toEqual([1])
  })

  it('buildSpecLevelSlugMetadata uses spec token and retry marker', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _specPaths: string[]
      _buildSpecLevelSlugMetadata: (retryCount: number) => {
        fileToken: string
        testNameToken: string
        retryToken: string
        hashInput: string
      }
    }

    service._specPaths = ['tests/advanced/specs/spec-level-recording.spec.ts']
    const metadata = service._buildSpecLevelSlugMetadata(2)

    expect(metadata.fileToken).toBe('spec_level_recording_spec')
    expect(metadata.testNameToken).toBe('spec_level_recording_spec')
    expect(metadata.retryToken).toBe('_retry2')
    expect(metadata.hashInput).toContain('spec|')
  })

  it('_startSpecLevelRecording preserves metadata built from every spec path', async () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _specPaths: string[]
      _startRecordingForMetadata: (
        metadata: {
          fileToken: string
          testNameToken: string
          retryToken: string
          hashInput: string
        },
        retryCount: number,
      ) => Promise<void>
      _startSpecLevelRecording: (retryCount: number) => Promise<void>
    }

    service._specPaths = ['tests/specs/a.test.ts', 'tests/specs/b.test.ts']

    let capturedRetryCount = -1
    let capturedMetadata:
      | {
          fileToken: string
          testNameToken: string
          retryToken: string
          hashInput: string
        }
      | undefined
    service._startRecordingForMetadata = async (metadata, retryCount) => {
      capturedMetadata = metadata
      capturedRetryCount = retryCount
    }

    await service._startSpecLevelRecording(2)

    expect(capturedRetryCount).toBe(2)
    expect(capturedMetadata).toEqual({
      fileToken: 'a_test',
      testNameToken: 'a_test_spec',
      retryToken: '_retry2',
      hashInput: 'spec|tests/specs/a.test.ts|tests/specs/b.test.ts|2',
    })
  })

  it('extractRetryValue floors valid retries and rejects invalid values', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _extractRetryValue: (value: unknown) => number | undefined
    }

    expect(service._extractRetryValue(2.9)).toBe(2)
    expect(service._extractRetryValue(0)).toBe(0)
    expect(service._extractRetryValue(-1)).toBeUndefined()
    expect(service._extractRetryValue(Number.NaN)).toBeUndefined()
    expect(service._extractRetryValue('2')).toBeUndefined()
  })

  it('extractExplicitRetryCount prefers test retry, then context, then currentTest', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _extractExplicitRetryCount: (
        test: Frameworks.Test,
        context: unknown,
      ) => number | undefined
    }

    expect(
      service._extractExplicitRetryCount(createTest({ _currentRetry: 3 }), {
        _currentRetry: 2,
        currentTest: { _currentRetry: 1 },
      }),
    ).toBe(3)
    expect(
      service._extractExplicitRetryCount(createTest(), {
        _currentRetry: 2,
      }),
    ).toBe(2)
    expect(
      service._extractExplicitRetryCount(createTest(), {
        currentTest: { _currentRetry: 1 },
      }),
    ).toBe(1)
  })

  it('resolveRetryContextForEntity tracks inferred retries across repeated entities', () => {
    const service = new WdioPuppeteerVideoService({
      recordOnRetries: true,
    }) as unknown as {
      _collectSlugMetadata: () => {
        fileToken: string
        testNameToken: string
        hashInput: string
        retryToken: string
      }
      _resolveRetryContextForEntity: (
        test: Frameworks.Test,
        context: unknown,
      ) => {
        explicitFrameworkRetry: number | undefined
        specFileRetryAttempt: number
        inferredEntityRetry: number | undefined
        effectiveRetryCount: number
      }
      _specFileRetryAttempt: number
    }

    service._collectSlugMetadata = () => ({
      fileToken: 'checkout_spec',
      testNameToken: 'adds_item',
      hashInput: 'checkout|adds_item',
      retryToken: '',
    })
    service._specFileRetryAttempt = 0

    const firstAttempt = service._resolveRetryContextForEntity(createTest(), {})
    const secondAttempt = service._resolveRetryContextForEntity(
      createTest(),
      {},
    )

    expect(firstAttempt.inferredEntityRetry).toBe(0)
    expect(firstAttempt.effectiveRetryCount).toBe(0)
    expect(secondAttempt.inferredEntityRetry).toBe(1)
    expect(secondAttempt.effectiveRetryCount).toBe(1)
  })

  it('applyRetryCountToMetadata and shouldRecordForRetryCount respect retry-only mode', () => {
    const alwaysRecordService = new WdioPuppeteerVideoService(
      {},
    ) as unknown as {
      _applyRetryCountToMetadata: (
        metadata: {
          fileToken: string
          testNameToken: string
          hashInput: string
          retryToken: string
        },
        retryCount: number,
      ) => {
        fileToken: string
        testNameToken: string
        hashInput: string
        retryToken: string
      }
      _shouldRecordForRetryCount: (retryCount: number) => boolean
    }
    const retryOnlyService = new WdioPuppeteerVideoService({
      recordOnRetries: true,
    }) as unknown as {
      _shouldRecordForRetryCount: (retryCount: number) => boolean
    }

    expect(
      alwaysRecordService._applyRetryCountToMetadata(
        {
          fileToken: 'checkout_spec',
          testNameToken: 'adds_item',
          hashInput: 'checkout|adds_item',
          retryToken: '',
        },
        2,
      ),
    ).toEqual({
      fileToken: 'checkout_spec',
      testNameToken: 'adds_item',
      hashInput: 'checkout|adds_item|retry=2',
      retryToken: '_retry2',
    })
    expect(
      alwaysRecordService._applyRetryCountToMetadata(
        {
          fileToken: 'checkout_spec',
          testNameToken: 'adds_item',
          hashInput: 'checkout|adds_item',
          retryToken: '_retry2',
        },
        0,
      ).retryToken,
    ).toBe('')
    expect(alwaysRecordService._shouldRecordForRetryCount(0)).toBe(true)
    expect(retryOnlyService._shouldRecordForRetryCount(0)).toBe(false)
    expect(retryOnlyService._shouldRecordForRetryCount(1)).toBe(true)
  })

  it('retry-only recordings are kept even when retry passes', async () => {
    const service = new WdioPuppeteerVideoService({
      recordOnRetries: true,
    }) as unknown as {
      _currentTestSlug: string
      _currentRecordingRetryCount: number
      _stopRecording: () => Promise<void>
      _deleteSegments: () => Promise<void>
      _resetTestState: () => Promise<void>
      _finalizeCurrentTestRecording: (passed: boolean) => Promise<void>
    }

    service._currentTestSlug = 'retry_slug'
    service._currentRecordingRetryCount = 1
    service._stopRecording = async () => {}
    let deleted = false
    service._deleteSegments = async () => {
      deleted = true
    }
    service._resetTestState = async () => {}

    await service._finalizeCurrentTestRecording(true)
    expect(deleted).toBe(false)
  })

  it('skipViewPortKickoff bypasses viewport kickoff logic', async () => {
    const skippedService = new WdioPuppeteerVideoService({
      skipViewPortKickoff: true,
    }) as unknown as {
      _kickOffScreencastFrames: (_page: unknown) => Promise<void>
      _kickOffScreencastFramesIfEnabled: (_page: unknown) => Promise<void>
    }

    let kickoffCalls = 0
    skippedService._kickOffScreencastFrames = async () => {
      kickoffCalls += 1
    }
    await skippedService._kickOffScreencastFramesIfEnabled({})
    expect(kickoffCalls).toBe(0)

    const enabledService = new WdioPuppeteerVideoService({
      skipViewPortKickoff: false,
    }) as unknown as {
      _kickOffScreencastFrames: (_page: unknown) => Promise<void>
      _kickOffScreencastFramesIfEnabled: (_page: unknown) => Promise<void>
    }

    enabledService._kickOffScreencastFrames = async () => {
      kickoffCalls += 1
    }
    await enabledService._kickOffScreencastFramesIfEnabled({})
    expect(kickoffCalls).toBe(1)
  })

  it('kickOffScreencastFrames performs both viewport writes even if the first one fails', async () => {
    vi.useFakeTimers()
    try {
      const service = new WdioPuppeteerVideoService({}) as unknown as {
        _kickOffScreencastFrames: (page: {
          setViewport: (viewport: {
            width: number
            height: number
          }) => Promise<void>
        }) => Promise<void>
      }

      const setViewport = vi
        .fn<(viewport: { width: number; height: number }) => Promise<void>>()
        .mockRejectedValueOnce(new Error('first resize failed'))
        .mockResolvedValueOnce(undefined)
      const kickoffPromise = service._kickOffScreencastFrames({
        setViewport,
      })

      await vi.advanceTimersByTimeAsync(50)
      await kickoffPromise

      expect(setViewport).toHaveBeenNthCalledWith(1, {
        width: 1281,
        height: 720,
      })
      expect(setViewport).toHaveBeenNthCalledWith(2, {
        width: 1280,
        height: 720,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('segmentOnWindowSwitch can disable window command segmentation', async () => {
    const service = new WdioPuppeteerVideoService({
      segmentOnWindowSwitch: false,
    }) as unknown as {
      _isChromium: boolean
      _ffmpegAvailable: boolean
      _browser: unknown
      _currentTestSlug: string
      _runSerializedRecordingTask: (task: () => Promise<void>) => Promise<void>
      beforeCommand: (commandName: string) => Promise<void>
      afterCommand: (commandName: string) => Promise<void>
    }

    service._isChromium = true
    service._ffmpegAvailable = true
    service._browser = {}
    service._currentTestSlug = 'active_test'
    let serializedTaskRuns = 0
    service._runSerializedRecordingTask = async () => {
      serializedTaskRuns += 1
    }

    await service.beforeCommand('closeWindow')
    await service.afterCommand('switchWindow')

    expect(serializedTaskRuns).toBe(0)
  })

  it('startRecording skips Puppeteer page lookup when slot acquisition fails', async () => {
    const browserCalls: string[] = []
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _browser: {
        execute: (script: unknown, markerId: string) => Promise<void>
        getPuppeteer: () => Promise<unknown>
        getWindowHandle: () => Promise<string>
      }
      _currentTestSlug: string
      _ensureFfmpegReady: () => Promise<boolean>
      _recordingSlotScheduler: {
        acquire: () => Promise<boolean>
        release: () => Promise<void>
      }
      _startRecording: () => Promise<boolean>
    }

    service._browser = {
      execute: async () => {
        browserCalls.push('execute')
      },
      getPuppeteer: async () => {
        browserCalls.push('getPuppeteer')
        return {}
      },
      getWindowHandle: async () => {
        browserCalls.push('getWindowHandle')
        return 'window-1'
      },
    }
    service._currentTestSlug = 'slot-order'
    service._ensureFfmpegReady = async () => true
    service._recordingSlotScheduler = {
      acquire: async () => false,
      release: async () => {},
    }

    await expect(service._startRecording()).resolves.toBe(false)
    expect(browserCalls).toEqual([])
  })

  it('startRecording releases the slot when page lookup fails after acquisition', async () => {
    const callOrder: string[] = []
    vi.spyOn(pageLookup, 'findActivePage').mockImplementation(async () => {
      callOrder.push('findActivePage')
      return undefined
    })
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _browser: {
        execute: (script: unknown, markerId: string) => Promise<void>
        getPuppeteer: () => Promise<unknown>
        getWindowHandle: () => Promise<string>
      }
      _currentTestSlug: string
      _ensureFfmpegReady: () => Promise<boolean>
      _recordingSlotScheduler: {
        acquire: () => Promise<boolean>
        release: () => Promise<void>
      }
      _startRecording: () => Promise<boolean>
    }

    service._browser = {
      execute: async () => {
        callOrder.push('execute')
      },
      getPuppeteer: async () => {
        callOrder.push('getPuppeteer')
        return {}
      },
      getWindowHandle: async () => {
        callOrder.push('getWindowHandle')
        return 'window-1'
      },
    }
    service._currentTestSlug = 'slot-release'
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
      'getPuppeteer',
      'getWindowHandle',
      'execute',
      'findActivePage',
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
        _recordedSegments: Set<string>
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

      expect(service._recordedSegments.has(recordingPath)).toBe(true)
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
        _currentTestSlug: string
        _recordedSegments: Set<string>
        _deferredPostProcessTasks: Array<{
          kind: string
          segmentPaths?: string[]
          mergedPath?: string
          transcodeToMp4?: { outputPath: string }
        }>
        _queueDeferredMergeForCurrentTest: () => Promise<void>
      }

      service._currentTestSlug = 'merge_test'
      service._recordedSegments.add(path.join(tempDir, 'merge_test_part1.webm'))
      service._recordedSegments.add(path.join(tempDir, 'merge_test_part2.webm'))

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
        _runFfmpeg: () => Promise<boolean>
        _transcodeToH264Mp4WithArgs: (
          inputPath: string,
          outputPath: string,
          ffmpegArgs: string[] | undefined,
        ) => Promise<boolean>
      }
      service._runFfmpeg = async () => {
        await fs.writeFile(outputPath, 'partial', 'utf8')
        return false
      }

      await expect(
        service._transcodeToH264Mp4WithArgs(inputPath, outputPath, undefined),
      ).resolves.toBe(false)
      await expect(fs.stat(outputPath)).rejects.toThrow()
      await expect(fs.readFile(inputPath, 'utf8')).resolves.toBe('source')
    })
  })

  it('finalizeIfRecording only runs serialized finalize work when recording is active', async () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _currentTestSlug: string
      _finalizeCurrentTestRecording: (passed: boolean) => Promise<void>
      _finalizeIfRecording: (passed: boolean) => Promise<void>
      _runSerializedRecordingTask: (task: () => Promise<void>) => Promise<void>
    }

    const finalized: boolean[] = []
    let serializedRuns = 0
    service._finalizeCurrentTestRecording = async (passed) => {
      finalized.push(passed)
    }
    service._runSerializedRecordingTask = async (task) => {
      serializedRuns += 1
      await task()
    }

    await service._finalizeIfRecording(false)
    service._currentTestSlug = 'active'
    await service._finalizeIfRecording(true)

    expect(serializedRuns).toBe(1)
    expect(finalized).toEqual([true])
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
      _mergeSegmentPathsToOutput: () => Promise<boolean>
    }

    const transcodeTasks: Array<{
      kind: 'transcode'
      inputPath: string
      outputPath: string
      deleteOriginal: boolean
      ffmpegArgs?: string[]
    }> = []
    service._mergeSegmentPathsToOutput = async () => true
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

  it('waitForWriteStream resolves true for clean completion and false for pre-errored streams', async () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _createWriteStreamTimeout: () => Promise<boolean>
      _waitForWriteStream: (segment: {
        recordingPath: string
        writeStream: {
          destroyed?: boolean
          destroy: (error?: Error) => void
        }
        writeStreamDone: Promise<void>
        writeStreamErrored: boolean
        writeStreamErrorMessage?: string
      }) => Promise<boolean>
    }

    service._createWriteStreamTimeout = () => {
      return new Promise<boolean>(() => {
        /* keep the timeout branch pending for this test */
      })
    }

    await expect(
      service._waitForWriteStream({
        recordingPath: 'clean.webm',
        writeStream: {
          destroy: () => {},
        },
        writeStreamDone: Promise.resolve(),
        writeStreamErrored: false,
      }),
    ).resolves.toBe(true)

    await expect(
      service._waitForWriteStream({
        recordingPath: 'errored.webm',
        writeStream: {
          destroy: () => {},
        },
        writeStreamDone: Promise.reject(new Error('already failed')),
        writeStreamErrored: true,
      }),
    ).resolves.toBe(false)
  })

  it('markSegmentAsUnclean resets transcode metadata back to the original recording output', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _markSegmentAsUnclean: (segment: {
        outputFormat: 'webm' | 'mp4'
        outputPath: string
        recordingFormat: 'webm' | 'mp4'
        recordingPath: string
        transcode: boolean
      }) => void
    }
    const segment = {
      outputFormat: 'mp4' as const,
      outputPath: 'segment.mp4',
      recordingFormat: 'webm' as const,
      recordingPath: 'segment.webm',
      transcode: true,
    }

    service._markSegmentAsUnclean(segment)

    expect(segment).toEqual({
      outputFormat: 'webm',
      outputPath: 'segment.webm',
      recordingFormat: 'webm',
      recordingPath: 'segment.webm',
      transcode: false,
    })
  })

  it('waitForWriteStream destroys timed-out streams before returning', async () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _waitForWriteStream: (segment: {
        recordingPath: string
        writeStream: {
          destroyed?: boolean
          destroy: (error?: Error) => void
        }
        writeStreamDone: Promise<void>
        writeStreamErrored: boolean
        writeStreamErrorMessage?: string
      }) => Promise<boolean>
      _createWriteStreamTimeout: () => Promise<boolean>
    }

    service._createWriteStreamTimeout = async () => false

    let rejectWriteStreamDone: ((error?: unknown) => void) | undefined
    const writeStreamDone = new Promise<void>((_resolve, reject) => {
      rejectWriteStreamDone = reject
    })
    const destroyErrors: Array<Error | undefined> = []
    const writeStream = {
      destroyed: false,
      destroy: (error?: Error) => {
        writeStream.destroyed = true
        destroyErrors.push(error)
        rejectWriteStreamDone?.(error)
      },
    }
    const segment: Parameters<typeof service._waitForWriteStream>[0] = {
      recordingPath: 'timed-out.webm',
      writeStream,
      writeStreamDone,
      writeStreamErrored: false,
    }

    await expect(service._waitForWriteStream(segment)).resolves.toBe(false)
    expect(writeStream.destroyed).toBe(true)
    expect(destroyErrors).toHaveLength(1)
    expect(segment.writeStreamErrored).toBe(true)
    expect(segment.writeStreamErrorMessage).toContain(
      'Timed out waiting for recording stream',
    )
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

  it('onPrepare disables persisted retry-state tracking when init fails', async () => {
    await withTempDir(async (tempDir) => {
      const blockedOutputDir = path.join(tempDir, 'blocked-output')
      await fs.writeFile(blockedOutputDir, 'blocker')

      const service = new WdioPuppeteerVideoService({
        outputDir: blockedOutputDir,
        recordOnRetries: true,
      }) as unknown as {
        onPrepare: () => Promise<void>
        onWorkerStart: (
          cid: string,
          capabilities: WebdriverIO.Capabilities,
          specs: string[],
        ) => Promise<void>
        _writeSpecRetryState: (
          cid: string,
          state: { specRetryKey: string; specFileRetryAttempt: number },
        ) => Promise<void>
        _log: (level: string, message: string) => void
      }

      const warnMessages: string[] = []
      let writeCalls = 0
      service._writeSpecRetryState = async () => {
        writeCalls += 1
      }
      service._log = (level, message) => {
        if (level === 'warn') {
          warnMessages.push(message)
        }
      }

      await expect(service.onPrepare()).resolves.toBeUndefined()
      await expect(
        service.onWorkerStart('0-0', { browserName: 'chrome' }, [
          'tests/specs/e2e.test.ts',
        ]),
      ).resolves.toBeUndefined()

      expect(writeCalls).toBe(0)
      expect(
        warnMessages.some((m) =>
          m.includes('Failed to initialize retry-state tracking'),
        ),
      ).toBe(true)
    })
  })

  it('_writeSpecRetryState does not propagate errors when write fails', async () => {
    await withTempDir(async (tempDir) => {
      const service = new WdioPuppeteerVideoService({
        outputDir: tempDir,
        recordOnRetries: true,
      }) as unknown as {
        _writeSpecRetryState: (
          cid: string,
          state: { specRetryKey: string; specFileRetryAttempt: number },
        ) => Promise<void>
        _log: (level: string, message: string) => void
      }

      const warnMessages: string[] = []
      const originalLog = service._log.bind(service)
      service._log = (level, message, ...rest) => {
        if (level === 'warn') {
          warnMessages.push(message)
        }
        originalLog(level, message, ...rest)
      }

      // Make the method fail by writing to a path that cannot exist (file as dir)
      const blockerFile = path.join(tempDir, '.wdio-video-retry-state')
      await fs.writeFile(blockerFile, 'blocker')

      // _writeSpecRetryState must resolve (not reject) even when I/O fails
      await expect(
        service._writeSpecRetryState('0-0', {
          specRetryKey: 'key',
          specFileRetryAttempt: 1,
        }),
      ).resolves.toBeUndefined()

      expect(warnMessages.some((m) => m.includes('Failed to persist'))).toBe(
        true,
      )
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

  it('_prepareRecordingPage tolerates missing window handles and best-effort focus failures', async () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _prepareRecordingPage: (browser: {
        execute: (script: unknown, markerId: string) => Promise<void>
        getPuppeteer: () => Promise<unknown>
        getWindowHandle: () => Promise<string>
      }) => Promise<
        | {
            page: { bringToFront: () => Promise<void> }
            windowHandle: string | undefined
          }
        | undefined
      >
    }

    const seenMarkerIds: string[] = []
    const page = {
      bringToFront: vi.fn(async () => {
        throw new Error('focus lost')
      }),
      evaluate: async () => seenMarkerIds[0],
    }

    const result = await service._prepareRecordingPage({
      execute: async (_script, markerId) => {
        seenMarkerIds.push(markerId)
      },
      getPuppeteer: async () => ({ pages: async () => [page] }),
      getWindowHandle: async () => {
        throw new Error('window closed')
      },
    })

    expect(result).toEqual({
      page,
      windowHandle: undefined,
    })
    expect(seenMarkerIds[0]).toBeTruthy()
    expect(page.bringToFront).toHaveBeenCalledTimes(1)
  })

  it('_prepareRecordingPage logs when no matching puppeteer page is found', async () => {
    vi.spyOn(pageLookup, 'findActivePage').mockResolvedValue(undefined)
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _prepareRecordingPage: (browser: {
        execute: (script: unknown, markerId: string) => Promise<void>
        getPuppeteer: () => Promise<unknown>
        getWindowHandle: () => Promise<string>
      }) => Promise<unknown>
      _log: (level: string, message: string) => void
    }

    const warnMessages: string[] = []
    service._log = (level, message) => {
      if (level === 'warn') {
        warnMessages.push(message)
      }
    }

    await expect(
      service._prepareRecordingPage({
        execute: async () => {},
        getPuppeteer: async () => ({}),
        getWindowHandle: async () => 'window-1',
      }),
    ).resolves.toBeUndefined()
    expect(warnMessages[0]).toContain('Could not find puppeteer page match')
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

  it('_readSpecRetryState returns persisted retry state when it is valid', async () => {
    await withTempDir(async (tempDir) => {
      const service = new WdioPuppeteerVideoService({
        outputDir: tempDir,
      }) as unknown as {
        _readSpecRetryState: (cid: string) => Promise<
          | {
              specRetryKey: string
              specFileRetryAttempt: number
            }
          | undefined
        >
      }

      const retryStatePath = retryState.getSpecRetryStatePathForCid(
        tempDir,
        '0-0',
      )
      await fs.mkdir(path.dirname(retryStatePath), { recursive: true })
      await fs.writeFile(
        retryStatePath,
        JSON.stringify({
          specRetryKey: 'retry-key',
          specFileRetryAttempt: 2,
        }),
        'utf8',
      )

      await expect(service._readSpecRetryState('0-0')).resolves.toEqual({
        specRetryKey: 'retry-key',
        specFileRetryAttempt: 2,
      })
    })
  })

  it('_readSpecRetryState warns and ignores invalid persisted retry state', async () => {
    await withTempDir(async (tempDir) => {
      const service = new WdioPuppeteerVideoService({
        outputDir: tempDir,
      }) as unknown as {
        _log: (level: string, message: string) => void
        _readSpecRetryState: (cid: string) => Promise<unknown>
      }

      const warnMessages: string[] = []
      service._log = (level, message) => {
        if (level === 'warn') {
          warnMessages.push(message)
        }
      }

      const retryStatePath = retryState.getSpecRetryStatePathForCid(
        tempDir,
        '0-0',
      )
      await fs.mkdir(path.dirname(retryStatePath), { recursive: true })
      await fs.writeFile(
        retryStatePath,
        JSON.stringify({
          specRetryKey: 'retry-key',
          specFileRetryAttempt: 'bad-value',
        }),
        'utf8',
      )

      await expect(service._readSpecRetryState('0-0')).resolves.toBeUndefined()
      expect(warnMessages[0]).toContain('specFileRetryAttempt is invalid')
    })
  })

  it('_deleteSpecRetryState logs unexpected unlink failures', async () => {
    await withTempDir(async (tempDir) => {
      const service = new WdioPuppeteerVideoService({
        outputDir: tempDir,
      }) as unknown as {
        _deleteSpecRetryState: (cid: string) => Promise<void>
        _log: (level: string, message: string) => void
      }

      const traceMessages: string[] = []
      const retryStatePath = retryState.getSpecRetryStatePathForCid(
        tempDir,
        '0-0',
      )
      await fs.mkdir(retryStatePath, { recursive: true })
      service._log = (level, message) => {
        if (level === 'trace') {
          traceMessages.push(message)
        }
      }

      await service._deleteSpecRetryState('0-0')
      expect(traceMessages[0]).toContain('Failed to delete retry state')
    })
  })

  it('_warnMissingFfmpeg and _disableRecordingForWorker only log once', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _browser: unknown
      _canUseRecordingHooks: () => boolean
      _disableRecordingForWorker: (reason: string) => void
      _isChromium: boolean
      _log: (level: string, message: string) => void
      _warnMissingFfmpeg: (reason: string) => void
    }

    const warnMessages: string[] = []
    service._browser = {}
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
      _activeSegment: unknown
      _currentRecordingRetryCount: number
      _currentSegment: number
      _currentTestSlug: string
      _currentWindowHandle: string | undefined
      _isRecordingActive: () => boolean
      _recordedSegments: Set<string>
      _recordingSlotScheduler: {
        acquire: () => Promise<boolean>
        release: () => Promise<void>
      }
      _recorder: unknown
      _resetTestState: () => Promise<void>
    }

    let releaseCalls = 0
    service._recorder = {}
    service._activeSegment = {}
    service._currentSegment = 3
    service._currentTestSlug = 'active'
    service._currentRecordingRetryCount = 2
    service._currentWindowHandle = 'window-1'
    service._recordedSegments.add('segment.webm')
    service._recordingSlotScheduler = {
      acquire: async () => true,
      release: async () => {
        releaseCalls += 1
      },
    }

    expect(service._isRecordingActive()).toBe(true)
    await service._resetTestState()

    expect(service._isRecordingActive()).toBe(false)
    expect(service._currentSegment).toBe(0)
    expect(service._currentTestSlug).toBe('')
    expect(service._currentRecordingRetryCount).toBe(0)
    expect(service._currentWindowHandle).toBeUndefined()
    expect(service._recordedSegments.size).toBe(0)
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
        _recordedSegments: Set<string>
        _deleteSegments: () => Promise<void>
      }

      service._recordedSegments.add(seg1)
      service._recordedSegments.add(seg2)

      await service._deleteSegments()

      expect(service._recordedSegments.size).toBe(0)

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
