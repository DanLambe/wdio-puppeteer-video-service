import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Frameworks } from '@wdio/types'
import { afterEach, describe, expect, it } from 'vitest'
import WdioPuppeteerVideoService from '../../src/service.js'

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

describe('WdioPuppeteerVideoService unit', () => {
  afterEach(() => {
    const serviceClass = WdioPuppeteerVideoService as unknown as {
      _activeRecordingSlots: number
      _recordingSlotWaiters: Array<() => void>
    }
    serviceClass._activeRecordingSlots = 0
    serviceClass._recordingSlotWaiters = []
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

  it('constructor honors explicit service logLevel', () => {
    const service = new WdioPuppeteerVideoService({
      logLevel: 'silent',
    }) as unknown as {
      _logLevel: string
    }

    expect(service._logLevel).toBe('silent')
  })

  it('normalizeMp4Mode supports known values and falls back to auto', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _normalizeMp4Mode: (mode: string | undefined) => string
    }

    expect(service._normalizeMp4Mode('auto')).toBe('auto')
    expect(service._normalizeMp4Mode('direct')).toBe('direct')
    expect(service._normalizeMp4Mode('transcode')).toBe('transcode')
    expect(service._normalizeMp4Mode('invalid')).toBe('auto')
    expect(service._normalizeMp4Mode(undefined)).toBe('auto')
  })

  it('normalizeFileNameStyle supports known values and falls back to test', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _normalizeFileNameStyle: (mode: string | undefined) => string
    }

    expect(service._normalizeFileNameStyle('test')).toBe('test')
    expect(service._normalizeFileNameStyle('session')).toBe('session')
    expect(service._normalizeFileNameStyle('sessionFull')).toBe('sessionFull')
    expect(service._normalizeFileNameStyle('invalid')).toBe('test')
    expect(service._normalizeFileNameStyle(undefined)).toBe('test')
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
    const autoService = new WdioPuppeteerVideoService({
      outputFormat: 'mp4',
      mp4Mode: 'auto',
    }) as unknown as {
      _forceMp4Transcode: boolean
      _resolveFfmpegPath: () => string
      _supportsDirectMp4: (ffmpegPath: string) => Promise<boolean>
      _configureMp4RecordingMode: () => Promise<void>
    }

    autoService._resolveFfmpegPath = () => '/tmp/ffmpeg'
    autoService._supportsDirectMp4 = async () => false
    await autoService._configureMp4RecordingMode()
    expect(autoService._forceMp4Transcode).toBe(true)

    const directService = new WdioPuppeteerVideoService({
      outputFormat: 'mp4',
      mp4Mode: 'direct',
    }) as unknown as {
      _forceMp4Transcode: boolean
      _resolveFfmpegPath: () => string
      _supportsDirectMp4: (ffmpegPath: string) => Promise<boolean>
      _configureMp4RecordingMode: () => Promise<void>
    }
    directService._resolveFfmpegPath = () => '/tmp/ffmpeg'
    directService._supportsDirectMp4 = async () => false
    await directService._configureMp4RecordingMode()
    expect(directService._forceMp4Transcode).toBe(false)
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
      _startRecordingForEntity: (
        test: Frameworks.Test,
        context: unknown,
        retryCount: number,
      ) => Promise<void>
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
    service._startRecordingForEntity = async () => {
      startCount += 1
      service._currentTestSlug = 'spec_level_slug'
    }

    const finalizedStatuses: boolean[] = []
    service._finalizeCurrentTestRecording = async (passed) => {
      finalizedStatuses.push(passed)
    }

    await service.beforeTest(createTest({ title: 'first spec test' }), {})
    await service.beforeTest(createTest({ title: 'second spec test' }), {})
    await service.afterTest(createTest({ title: 'first spec test' }), {}, {
      passed: false,
      duration: 100,
      retries: { attempts: 0, limit: 0 },
      exception: '',
      status: 'failed',
    } as Frameworks.TestResult)
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

  it('normalizeNonNegativeInt accepts zero and rejects negative values', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _normalizeNonNegativeInt: (
        value: number | undefined,
        fallback: number,
      ) => number
    }

    expect(service._normalizeNonNegativeInt(0, 7)).toBe(0)
    expect(service._normalizeNonNegativeInt(2.9, 7)).toBe(2)
    expect(service._normalizeNonNegativeInt(-1, 7)).toBe(7)
    expect(service._normalizeNonNegativeInt(undefined, 7)).toBe(7)
  })

  it('retry-only recordings are kept even when retry passes', async () => {
    const service = new WdioPuppeteerVideoService({
      recordOnRetries: true,
    }) as unknown as {
      _currentTestSlug: string
      _currentRecordingRetryCount: number
      _stopRecording: () => Promise<void>
      _deleteSegments: () => Promise<void>
      _resetTestState: () => void
      _finalizeCurrentTestRecording: (passed: boolean) => Promise<void>
    }

    service._currentTestSlug = 'retry_slug'
    service._currentRecordingRetryCount = 1
    service._stopRecording = async () => {}
    let deleted = false
    service._deleteSegments = async () => {
      deleted = true
    }
    service._resetTestState = () => {}

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

  it('maxConcurrentRecordings gates recorder slots across service instances', async () => {
    const firstService = new WdioPuppeteerVideoService({
      maxConcurrentRecordings: 1,
    }) as unknown as {
      _acquireRecordingSlot: () => Promise<boolean>
      _releaseRecordingSlot: () => void
    }
    const secondService = new WdioPuppeteerVideoService({
      maxConcurrentRecordings: 1,
    }) as unknown as {
      _acquireRecordingSlot: () => Promise<boolean>
      _releaseRecordingSlot: () => void
    }

    await firstService._acquireRecordingSlot()

    let secondAcquired = false
    const secondAcquirePromise = secondService
      ._acquireRecordingSlot()
      .then(() => {
        secondAcquired = true
      })

    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })
    expect(secondAcquired).toBe(false)

    firstService._releaseRecordingSlot()
    await secondAcquirePromise
    expect(secondAcquired).toBe(true)

    secondService._releaseRecordingSlot()
  })

  it('releases in-process slot when global recording slot cannot be acquired', async () => {
    const service = new WdioPuppeteerVideoService({
      maxConcurrentRecordings: 1,
      maxGlobalRecordings: 1,
    }) as unknown as {
      _ownsRecordingSlot: boolean
      _acquireInProcessRecordingSlot: () => Promise<void>
      _acquireGlobalRecordingSlot: () => Promise<boolean>
      _releaseInProcessRecordingSlot: () => void
      _acquireRecordingSlot: () => Promise<boolean>
    }

    let releaseCount = 0
    service._acquireInProcessRecordingSlot = async () => {
      service._ownsRecordingSlot = true
    }
    service._acquireGlobalRecordingSlot = async () => false
    service._releaseInProcessRecordingSlot = () => {
      if (service._ownsRecordingSlot) {
        service._ownsRecordingSlot = false
      }
      releaseCount += 1
    }

    const acquired = await service._acquireRecordingSlot()
    expect(acquired).toBe(false)
    expect(releaseCount).toBe(1)
  })

  it('resolves global recording lock directory using explicit and default paths', () => {
    const explicitDirService = new WdioPuppeteerVideoService({
      outputDir: 'videos-output',
      globalRecordingLockDir: '   lock-dir   ',
    }) as unknown as {
      _resolveGlobalRecordingLockDir: () => string
    }
    const defaultDirService = new WdioPuppeteerVideoService({
      outputDir: 'videos-output',
    }) as unknown as {
      _resolveGlobalRecordingLockDir: () => string
    }

    expect(explicitDirService._resolveGlobalRecordingLockDir()).toBe('lock-dir')
    expect(defaultDirService._resolveGlobalRecordingLockDir()).toBe(
      path.join('videos-output', '.wdio-video-global-slots'),
    )
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
        service._deferredPostProcessTasks[0].transcodeToMp4?.outputPath,
      ).toBe(path.join(tempDir, 'merge_test.mp4'))
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
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

  it('marks EPIPE and destroyed-stream write errors as benign', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _isBenignStreamWriteError: (error: NodeJS.ErrnoException) => boolean
    }

    expect(
      service._isBenignStreamWriteError({
        name: 'Error',
        message: 'broken pipe',
        code: 'EPIPE',
      }),
    ).toBe(true)
    expect(
      service._isBenignStreamWriteError({
        name: 'Error',
        message: 'Cannot call write after a stream was destroyed.',
      }),
    ).toBe(true)
    expect(
      service._isBenignStreamWriteError({
        name: 'Error',
        message: 'some other write error',
      }),
    ).toBe(false)
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

  it('reserveUniqueSlug appends run suffix to prevent collisions', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _reserveUniqueSlug: (baseSlug: string) => string
    }

    expect(service._reserveUniqueSlug('same_slug')).toBe('same_slug')
    expect(service._reserveUniqueSlug('same_slug')).toBe('same_slug_run2')
  })

  it('buildSessionIdToken prefers first guid segment', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _buildSessionIdToken: (sessionId: string | undefined) => string
    }

    const token = service._buildSessionIdToken(
      '550e8400-e29b-41d4-a716-446655440000',
    )
    expect(token).toBe('550e8400')
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
      _getMaxSlugLength: () => number
    }

    service._sessionIdToken = 'abc123def456'
    const slug = service._buildTestSlug(
      createTest({
        title:
          'this is a very long test title that should be truncated to respect the filename budget',
      }),
    )
    const maxSlugLength = service._getMaxSlugLength()

    expect(slug).toMatch(/^this_[a-z0-9_]*abc123def456_[a-f0-9]{8}$/)
    expect(slug.length).toBeLessThanOrEqual(maxSlugLength)
  })

  it('segment path includes slug, segment, and requested format', () => {
    const service = new WdioPuppeteerVideoService({
      outputDir: './videos-output',
    }) as unknown as {
      _currentTestSlug: string
      _currentSegment: number
      _getSegmentPath: (format: 'webm' | 'mp4') => string
    }

    service._currentTestSlug = 'test_slug_deadbeef'
    service._currentSegment = 3

    const segmentPath = service._getSegmentPath('mp4')
    expect(path.basename(segmentPath)).toBe('test_slug_deadbeef_part3.mp4')
    expect(segmentPath).toContain('videos-output')
  })

  it('merged path uses slug without segment suffix', () => {
    const service = new WdioPuppeteerVideoService({
      outputDir: './videos-output',
    }) as unknown as {
      _currentTestSlug: string
      _getMergedOutputPath: (format: 'webm' | 'mp4') => string
    }

    service._currentTestSlug = 'test_slug_deadbeef'
    const mergedPath = service._getMergedOutputPath('mp4')
    expect(path.basename(mergedPath)).toBe('test_slug_deadbeef.mp4')
  })

  it('extractPartNumber parses segment index from filename', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _extractPartNumber: (filePath: string) => number
    }

    expect(service._extractPartNumber('/tmp/video_part12.mp4')).toBe(12)
    expect(service._extractPartNumber('/tmp/video.mp4')).toBe(
      Number.MAX_SAFE_INTEGER,
    )
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

  it('normalizePositiveInt floors positive numbers and rejects invalid input', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _normalizePositiveInt: (
        value: number | undefined,
        fallback: number,
      ) => number
    }

    expect(service._normalizePositiveInt(29.9, 10)).toBe(29)
    expect(service._normalizePositiveInt(0, 10)).toBe(10)
    expect(service._normalizePositiveInt(Number.NaN, 10)).toBe(10)
    expect(service._normalizePositiveInt(undefined, 10)).toBe(10)
  })

  it('normalizeLogLevel supports WDIO-style levels and fallback', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _normalizeLogLevel: (level: string | undefined) => string
    }

    expect(service._normalizeLogLevel('trace')).toBe('trace')
    expect(service._normalizeLogLevel('debug')).toBe('debug')
    expect(service._normalizeLogLevel('info')).toBe('info')
    expect(service._normalizeLogLevel('warn')).toBe('warn')
    expect(service._normalizeLogLevel('error')).toBe('error')
    expect(service._normalizeLogLevel('silent')).toBe('silent')
    expect(service._normalizeLogLevel('verbose')).toBe('warn')
    expect(service._normalizeLogLevel(undefined)).toBe('warn')
  })

  it('resolveWdioLogLevel reads browser options when available', () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _resolveWdioLogLevel: (browser: unknown) => string | undefined
    }

    const browserStub = {
      options: { logLevel: 'debug' },
      config: { logLevel: 'error' },
    }

    expect(service._resolveWdioLogLevel(browserStub)).toBe('debug')
  })
})
