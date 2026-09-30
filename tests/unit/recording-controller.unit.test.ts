import { createWriteStream, type WriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { finished } from 'node:stream/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Browser } from 'webdriverio'
import { nodeFileSystem, systemClock } from '../../src/service/boundaries.js'
import { CaptureSession } from '../../src/service/capture-session.js'
import type { ActiveSegment } from '../../src/service/constants.js'
import type { ServiceLogger } from '../../src/service/logging.js'
import type { MediaPipeline } from '../../src/service/media-pipeline.js'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import { PuppeteerCaptureEngine } from '../../src/service/puppeteer-capture-engine.js'
import {
  RecordingController,
  type RecordingControllerOptions,
} from '../../src/service/recording-controller.js'
import { RecordingMediaCoordinator } from '../../src/service/recording-media-coordinator.js'
import type { ScreencastRecorder } from '../../src/service/screencast-recorder.js'
import {
  type RecordingAllurePort,
  WorkerRecordingCoordinator,
} from '../../src/service/worker-recording-coordinator.js'
import type { WdioPuppeteerVideoServiceOptions } from '../../src/types.js'
import type { SlugMetadata } from '../../src/video-name-utils.js'

const METADATA: SlugMetadata = {
  fileToken: 'checkout_spec',
  hashInput: 'checkout|adds-item|2',
  retryToken: '_retry2',
  testNameToken: 'Adds an item!',
}

type LogCall = Readonly<{
  details: unknown
  level: Parameters<ServiceLogger>[0]
  message: string
}>

interface ControllerHarness {
  readonly acquireSlot: ReturnType<
    typeof vi.fn<
      RecordingControllerOptions['recordingSlotScheduler']['acquire']
    >
  >
  readonly captureEngine: RecordingControllerOptions['captureEngine']
  readonly controller: RecordingController
  readonly ensureReady: ReturnType<
    typeof vi.fn<RecordingControllerOptions['ffmpegRuntime']['ensureReady']>
  >
  readonly logs: LogCall[]
  readonly media: RecordingMediaCoordinator
  readonly releaseSlot: ReturnType<
    typeof vi.fn<
      RecordingControllerOptions['recordingSlotScheduler']['release']
    >
  >
  readonly session: CaptureSession
  readonly setSlotOwned: (owned: boolean) => void
  readonly shouldTranscode: ReturnType<
    typeof vi.fn<RecordingControllerOptions['ffmpegRuntime']['shouldTranscode']>
  >
  readonly startCapture: ReturnType<
    typeof vi.fn<RecordingControllerOptions['captureEngine']['startCapture']>
  >
  readonly transcode: ReturnType<
    typeof vi.fn<Pick<MediaPipeline, 'transcode'>['transcode']>
  >
}

const createHarness = (
  serviceOptions: WdioPuppeteerVideoServiceOptions = {},
  createCaptureEngine?: (
    session: CaptureSession,
    log: ServiceLogger,
  ) => RecordingControllerOptions['captureEngine'],
): ControllerHarness => {
  const resolved = resolveServiceConfiguration(serviceOptions, 'linux')
  const session = new CaptureSession()
  const logs: LogCall[] = []
  const log: ServiceLogger = (level, message, details) => {
    logs.push({ details, level, message })
  }
  const ensureReady = vi.fn(async () => true)
  const shouldTranscode = vi.fn(() => false)
  const ffmpegRuntime: RecordingControllerOptions['ffmpegRuntime'] = {
    ensureReady,
    resolvePath: vi.fn(() => 'ffmpeg'),
    shouldTranscode,
  }
  const startCapture = vi.fn(async () => ({ started: false as const }))
  const captureEngine: RecordingControllerOptions['captureEngine'] =
    createCaptureEngine?.(session, log) ?? {
      afterWindowCommand: vi.fn(async () => {}),
      beforeWindowCommand: vi.fn(async () => {}),
      resetRecording: vi.fn(async () => {
        session.resetRecording()
      }),
      startCapture,
      stopCapture: vi.fn(async () => {
        const { segment } = session.detachCapture()
        return { segment, streamOk: true }
      }),
    }
  let slotOwned = false
  const acquireSlot = vi.fn(async () => {
    slotOwned = true
    return true
  })
  const releaseSlot = vi.fn(async () => {
    slotOwned = false
  })
  const recordingSlotScheduler: RecordingControllerOptions['recordingSlotScheduler'] =
    {
      acquire: acquireSlot,
      get ownsGlobalRecordingSlot() {
        return false
      },
      get ownsRecordingSlot() {
        return slotOwned
      },
      release: releaseSlot,
    }
  const transcode = vi.fn(async () => undefined)
  const mediaPipeline: Pick<
    MediaPipeline,
    'merge' | 'reportFailure' | 'transcode'
  > = {
    merge: vi.fn(async () => undefined),
    reportFailure: vi.fn(),
    transcode,
  }
  const media = new RecordingMediaCoordinator({
    captureSession: session,
    ffmpegRuntime,
    fileSystem: nodeFileSystem,
    getManifestRecorder: () => undefined,
    log,
    mediaPipeline,
    options: resolved.options,
  })
  const controller = new RecordingController({
    captureEngine,
    captureSession: session,
    ffmpegRuntime,
    getManifestRecorder: () => undefined,
    log,
    maxSlugLength: resolved.maxSlugLength,
    media,
    options: resolved.options,
    recordingSlotScheduler,
  })

  return {
    acquireSlot,
    captureEngine,
    controller,
    ensureReady,
    logs,
    media,
    releaseSlot,
    session,
    setSlotOwned: (owned) => {
      slotOwned = owned
    },
    shouldTranscode,
    startCapture,
    transcode,
  }
}

const createActiveSegment = (recordingPath: string): ActiveSegment => ({
  onRecorderError: vi.fn(),
  onWriteStreamError: vi.fn(),
  outputFormat: 'webm',
  outputPath: recordingPath,
  recordingFormat: 'webm',
  recordingPath,
  transcode: false,
  transcodeOptions: { deleteOriginal: true },
  writeStream: {} as WriteStream,
  writeStreamDone: Promise.resolve(),
  writeStreamErrored: false,
})

const attachTranscodedSegment = async (
  harness: ControllerHarness,
  recordingPath: string,
  outputPath: string,
): Promise<void> => {
  await fs.writeFile(recordingPath, 'captured-media')
  harness.session.beginRecording(path.parse(recordingPath).name)
  harness.session.attachCapture({
    recorder: {} as ScreencastRecorder,
    segment: {
      ...createActiveSegment(recordingPath),
      outputFormat: 'mp4',
      outputPath,
      transcode: true,
    },
    windowHandle: undefined,
  })
}

const createRealCaptureEngine =
  (serviceOptions: WdioPuppeteerVideoServiceOptions) =>
  (session: CaptureSession, log: ServiceLogger): PuppeteerCaptureEngine =>
    new PuppeteerCaptureEngine({
      capture: resolveServiceConfiguration(serviceOptions, 'linux').options
        .capture,
      clock: systemClock,
      connectPuppeteer: async () => {
        throw new Error('Capture is attached directly')
      },
      fileSystem: nodeFileSystem,
      getSessionToken: () => 'session',
      log,
      onConnectionFailure: () => {},
      onProtocolChanged: () => {},
      session,
      startScreencast: async () => {
        throw new Error('Capture is attached directly')
      },
      uuid: () => 'uuid',
    })

type ControlledRecorder = PassThrough & {
  abort: ReturnType<typeof vi.fn<() => Promise<void>>>
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>
}

// A recorder streaming into a real file, as the engine attaches one, whose
// capture has already failed for `incompleteReason` when that is set.
const attachControlledCapture = (
  session: CaptureSession,
  recordingPath: string,
  incompleteReason: string | undefined,
): ControlledRecorder => {
  const recorder = new PassThrough() as ControlledRecorder
  Object.assign(recorder, {
    abort: vi.fn(async () => {
      recorder.destroy()
    }),
    ffmpegResult: { code: 0, diagnostic: '', signal: null },
    frameCount: 5,
    incompleteReason,
    queueStats: {
      highWaterBlocks: 0,
      highWaterBytes: 0,
      highWaterLagSeconds: 0,
      pendingBlocks: 0,
      pendingBytes: 0,
    },
    stop: vi.fn(async () => {
      recorder.end()
    }),
  })
  const writeStream = createWriteStream(recordingPath, { flags: 'r+' })
  recorder.pipe(writeStream)
  session.attachCapture({
    recorder: recorder as unknown as ScreencastRecorder,
    segment: {
      ...createActiveSegment(recordingPath),
      writeStream,
      writeStreamDone: finished(writeStream),
    },
    windowHandle: undefined,
  })
  return recorder
}

const createEntityCoordinator = (
  harness: ControllerHarness,
  serviceOptions: WdioPuppeteerVideoServiceOptions,
  manifest: {
    completeCurrent: ReturnType<typeof vi.fn<() => Promise<string>>>
  },
  attachRetainedVideos: RecordingAllurePort['attachRetainedVideos'],
): WorkerRecordingCoordinator => {
  const coordinator = new WorkerRecordingCoordinator({
    actions: {
      finalizeMedia: (passed, keep) =>
        harness.controller.finalizeMedia(passed, keep),
      getAvailability: () => ({ available: true }),
      getRecordedPaths: () => harness.session.recordedPaths,
      isRecordingActive: () => harness.session.isRecordingActive,
      resetRecording: () => harness.controller.reset(),
      runSerialized: (task) => harness.controller.runSerialized(task),
      startRecording: (metadata, retry) =>
        harness.controller.startForMetadata(metadata, retry),
    },
    allure: { attachRetainedVideos },
    getLogLevel: () => 'warn',
    log: vi.fn(),
    options: resolveServiceConfiguration(serviceOptions).options,
  })
  coordinator.configureSession({
    framework: 'mocha',
    specFileRetryAttempt: 0,
    manifest: {
      currentEntryId: 'entry',
      beginEntity: async () => 'entry',
      completeCurrent: manifest.completeCurrent,
      recordResult: async () => {},
      setCurrentAttempt: () => {},
    },
  })
  return coordinator
}

const withTempDir = async (
  run: (tempDir: string) => Promise<void>,
): Promise<void> => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wdio-recording-controller-'),
  )
  try {
    await run(tempDir)
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true })
  }
}

describe('RecordingController', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps FFmpeg lazy until a browser-backed recording starts', async () => {
    const harness = createHarness()

    await expect(
      harness.controller.startForMetadata(METADATA, 2),
    ).resolves.toBe(false)

    expect(harness.ensureReady).not.toHaveBeenCalled()
    expect(harness.startCapture).not.toHaveBeenCalled()
  })

  it('checks FFmpeg before acquiring a slot and starting capture', async () => {
    const harness = createHarness()
    const callOrder: string[] = []
    harness.session.setBrowser({} as Browser)
    harness.ensureReady.mockImplementation(async () => {
      callOrder.push('ensureReady')
      return true
    })
    harness.acquireSlot.mockImplementation(async () => {
      callOrder.push('acquire')
      harness.setSlotOwned(true)
      return true
    })
    harness.releaseSlot.mockImplementation(async () => {
      callOrder.push('release')
      harness.setSlotOwned(false)
    })
    harness.startCapture.mockImplementation(async () => {
      callOrder.push('startCapture')
      return { started: false }
    })

    await expect(
      harness.controller.startForMetadata(METADATA, 2),
    ).resolves.toBe(false)

    expect(callOrder).toEqual([
      'ensureReady',
      'acquire',
      'startCapture',
      'release',
    ])
  })

  it('skips capture when slot acquisition fails', async () => {
    const harness = createHarness({
      concurrency: { startMode: 'fast-fail', startTimeoutMs: 1234 },
    })
    harness.session.setBrowser({} as Browser)
    harness.acquireSlot.mockResolvedValue(false)

    await expect(
      harness.controller.startForMetadata(METADATA, 2),
    ).resolves.toBe(false)

    expect(harness.startCapture).not.toHaveBeenCalled()
    expect(harness.releaseSlot).not.toHaveBeenCalled()
    expect(
      harness.logs.some((entry) => entry.message.includes('within 1234ms')),
    ).toBe(true)
  })

  it('skips slot acquisition when FFmpeg is unavailable', async () => {
    const harness = createHarness()
    harness.session.setBrowser({} as Browser)
    harness.ensureReady.mockResolvedValue(false)

    await expect(
      harness.controller.startForMetadata(METADATA, 2),
    ).resolves.toBe(false)

    expect(harness.acquireSlot).not.toHaveBeenCalled()
    expect(harness.startCapture).not.toHaveBeenCalled()
  })

  it('keeps the slot while a capture is active', async () => {
    const harness = createHarness()
    harness.session.setBrowser({} as Browser)
    harness.startCapture.mockImplementation(async () => {
      harness.session.attachCapture({
        recorder: {} as ScreencastRecorder,
        segment: createActiveSegment('active.webm'),
        windowHandle: 'window-1',
      })
      return {
        started: true,
      }
    })

    await expect(
      harness.controller.startForMetadata(METADATA, 2),
    ).resolves.toBe(true)

    expect(harness.releaseSlot).not.toHaveBeenCalled()
    expect(harness.controller.ownsResources).toBe(true)
  })

  it('logs capture startup failures and releases the slot', async () => {
    const harness = createHarness()
    harness.session.setBrowser({} as Browser)
    const failure = new Error('capture unavailable')
    harness.startCapture.mockRejectedValue(failure)

    await expect(
      harness.controller.startForMetadata(METADATA, 2),
    ).resolves.toBe(false)

    expect(harness.releaseSlot).toHaveBeenCalledOnce()
    expect(
      harness.logs.some(
        (entry) => entry.level === 'error' && entry.details === failure,
      ),
    ).toBe(true)
  })

  it('preserves capture startup errors under the error policy', async () => {
    const harness = createHarness({ failurePolicy: 'error' })
    harness.session.setBrowser({} as Browser)
    const failure = new Error('capture unavailable')
    harness.startCapture.mockRejectedValue(failure)

    await expect(harness.controller.startForMetadata(METADATA, 2)).rejects.toBe(
      failure,
    )

    expect(harness.releaseSlot).toHaveBeenCalledOnce()
  })

  it('does not delegate window commands when segmentation is disabled', async () => {
    const harness = createHarness({
      recording: { windowChanges: 'ignore' },
    })
    harness.session.beginRecording('active_test')

    await harness.controller.beforeWindowCommand('closeWindow')
    await harness.controller.afterWindowCommand('switchWindow')

    expect(harness.captureEngine.beforeWindowCommand).not.toHaveBeenCalled()
    expect(harness.captureEngine.afterWindowCommand).not.toHaveBeenCalled()
  })

  it('delegates segmented window commands with serialized capture operations', async () => {
    const harness = createHarness()
    harness.session.setBrowser({} as Browser)
    harness.session.beginRecording('active_test')
    const operationOrder: string[] = []
    vi.mocked(harness.captureEngine.beforeWindowCommand).mockImplementation(
      async (_commandName, operations) => {
        await operations.runSerialized(async () => {
          operationOrder.push('serialized')
        })
        await operations.stopRecording()
        await operations.startRecording()
      },
    )

    await harness.controller.beforeWindowCommand('closeWindow')
    await harness.controller.afterWindowCommand('switchWindow')

    expect(operationOrder).toEqual(['serialized'])
    expect(harness.captureEngine.beforeWindowCommand).toHaveBeenCalledOnce()
    expect(harness.captureEngine.afterWindowCommand).toHaveBeenCalledOnce()
  })

  it('keeps an already initialized recording entity active', async () => {
    const harness = createHarness()
    harness.session.beginRecording('already-active')

    await expect(
      harness.controller.startForMetadata(METADATA, 2),
    ).resolves.toBe(true)

    expect(harness.ensureReady).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'deletes unretained media',
      options: {},
      keepArtifacts: false,
      expectedMethod: 'deleteRecordedSegments',
    },
    {
      label: 'merges retained media immediately',
      options: { processing: { merge: { enabled: true } } },
      keepArtifacts: true,
      expectedMethod: 'mergeCurrentSegments',
    },
    {
      label: 'queues retained media for deferred merging',
      options: {
        processing: {
          merge: { enabled: true },
          timing: 'after-worker' as const,
        },
      },
      keepArtifacts: true,
      expectedMethod: 'queueDeferredMerge',
    },
  ])('$label', async ({ options, keepArtifacts, expectedMethod }) => {
    const harness = createHarness(options)
    harness.session.beginRecording('finalize')
    const deleteRecordedSegments = vi
      .spyOn(harness.media, 'deleteRecordedSegments')
      .mockResolvedValue(undefined)
    const mergeCurrentSegments = vi
      .spyOn(harness.media, 'mergeCurrentSegments')
      .mockResolvedValue(undefined)
    const queueDeferredMerge = vi
      .spyOn(harness.media, 'queueDeferredMerge')
      .mockImplementation(async () => {
        harness.media.enqueue({
          kind: 'transcode',
          inputPath: 'input.webm',
          outputPath: 'output.mp4',
          deleteOriginal: true,
        })
      })

    const result = await harness.controller.finalizeMedia(true, keepArtifacts)

    const calls = {
      deleteRecordedSegments: deleteRecordedSegments.mock.calls.length,
      mergeCurrentSegments: mergeCurrentSegments.mock.calls.length,
      queueDeferredMerge: queueDeferredMerge.mock.calls.length,
    }
    expect(calls[expectedMethod as keyof typeof calls]).toBe(1)
    expect(result.deferred).toBe(expectedMethod === 'queueDeferredMerge')
  })

  it('returns an empty snapshot when no recording entity is active', async () => {
    const harness = createHarness()

    await expect(harness.controller.finalizeMedia(true, true)).resolves.toEqual(
      { deferred: false, paths: [] },
    )
  })

  it('deletes an unretained raw capture without transcoding it', async () => {
    await withTempDir(async (tempDir) => {
      const recordingPath = path.join(tempDir, 'discarded.webm')
      const outputPath = path.join(tempDir, 'discarded.mp4')
      const harness = createHarness({
        outputDir: tempDir,
        processing: {
          format: 'mp4',
          transcode: { enabled: true },
        },
      })
      await attachTranscodedSegment(harness, recordingPath, outputPath)

      await expect(
        harness.controller.finalizeMedia(true, false),
      ).resolves.toEqual({ deferred: false, paths: [] })

      expect(harness.transcode).not.toHaveBeenCalled()
      await expect(fs.stat(recordingPath)).rejects.toThrow()
      await expect(fs.stat(outputPath)).rejects.toThrow()
    })
  })

  it('transcodes a retained final segment exactly once', async () => {
    await withTempDir(async (tempDir) => {
      const recordingPath = path.join(tempDir, 'failed.webm')
      const outputPath = path.join(tempDir, 'failed.mp4')
      const harness = createHarness({
        outputDir: tempDir,
        processing: {
          format: 'mp4',
          transcode: { enabled: true },
        },
      })
      harness.transcode.mockResolvedValue(outputPath)
      await attachTranscodedSegment(harness, recordingPath, outputPath)

      await expect(
        harness.controller.finalizeMedia(false, true),
      ).resolves.toEqual({ deferred: false, paths: [outputPath] })

      expect(harness.transcode).toHaveBeenCalledOnce()
    })
  })

  it('still transcodes a mid-test segment before retention is known', async () => {
    await withTempDir(async (tempDir) => {
      const recordingPath = path.join(tempDir, 'retained.webm')
      const outputPath = path.join(tempDir, 'retained.mp4')
      const harness = createHarness({
        outputDir: tempDir,
        processing: {
          format: 'mp4',
          transcode: { enabled: true },
        },
      })
      harness.transcode.mockResolvedValue(outputPath)
      await attachTranscodedSegment(harness, recordingPath, outputPath)

      await harness.controller.stopRecording()

      expect(harness.transcode).toHaveBeenCalledOnce()
      expect(harness.session.recordedPaths).toEqual([outputPath])
    })
  })

  it('retains unmerged media without scheduling post-processing', async () => {
    const harness = createHarness()
    harness.session.beginRecording('retained')
    harness.session.addRecordedPath('retained.webm')
    const mergeCurrentSegments = vi.spyOn(harness.media, 'mergeCurrentSegments')
    const queueDeferredMerge = vi.spyOn(harness.media, 'queueDeferredMerge')

    await expect(harness.controller.finalizeMedia(true, true)).resolves.toEqual(
      { deferred: false, paths: ['retained.webm'] },
    )
    expect(mergeCurrentSegments).not.toHaveBeenCalled()
    expect(queueDeferredMerge).not.toHaveBeenCalled()
  })

  it('releases a stale recording slot when capture has no work', async () => {
    const harness = createHarness()
    harness.setSlotOwned(true)

    await harness.controller.stopRecording()

    expect(harness.releaseSlot).toHaveBeenCalledOnce()
  })

  it('logs warn-policy task failures and continues serialized work', async () => {
    const harness = createHarness({ failurePolicy: 'warn' })
    const seenTasks: string[] = []
    const failure = new Error('boom')

    await Promise.all([
      harness.controller.runSerialized(async () => {
        seenTasks.push('first')
        throw failure
      }),
      harness.controller.runSerialized(async () => {
        seenTasks.push('second')
      }),
    ])

    expect(seenTasks).toEqual(['first', 'second'])
    expect(
      harness.logs.filter(
        (entry) => entry.level === 'error' && entry.details === failure,
      ),
    ).toHaveLength(1)
  })

  it('rejects error-policy task failures without blocking later work', async () => {
    const harness = createHarness({ failurePolicy: 'error' })
    const seenTasks: string[] = []
    const failure = new Error('boom')

    const first = harness.controller.runSerialized(async () => {
      seenTasks.push('first')
      throw failure
    })
    const second = harness.controller.runSerialized(async () => {
      seenTasks.push('second')
    })

    await expect(first).rejects.toBe(failure)
    await expect(second).resolves.toBeUndefined()
    expect(seenTasks).toEqual(['first', 'second'])
  })

  it('builds a session-aware unique slug and reserves collision-safe output', async () => {
    await withTempDir(async (tempDir) => {
      const harness = createHarness({ outputDir: tempDir })
      harness.session.setBrowser({} as Browser)
      harness.controller.setSessionId('550e8400-e29b-41d4-a716-446655440000')
      let outputPath = ''
      harness.startCapture.mockImplementation(async ({ createOutput }) => {
        const desiredPath = path.join(
          tempDir,
          `${harness.session.currentTestSlug}_part1.webm`,
        )
        await fs.writeFile(desiredPath, 'existing')
        outputPath = (await createOutput()).recordingPath
        return { started: false }
      })

      await harness.controller.startForMetadata(METADATA, 2)

      expect(harness.session.currentTestSlug).toMatch(
        /^adds_an_item_550e8400_[a-f0-9]{8}_retry2$/u,
      )
      expect(outputPath).toBe(
        path.join(
          tempDir,
          `${harness.session.currentTestSlug}_run2_part1.webm`,
        ),
      )
    })
  })

  it('warns once when direct MP4 output is requested', async () => {
    await withTempDir(async (tempDir) => {
      const harness = createHarness({
        outputDir: tempDir,
        processing: { format: 'mp4', mp4Mode: 'direct' },
      })
      harness.session.setBrowser({} as Browser)
      harness.shouldTranscode.mockReturnValue(false)
      const outputs: Array<{
        recordingFormat: string
        recordingPath: string
      }> = []
      harness.startCapture.mockImplementation(async ({ createOutput }) => {
        outputs.push(await createOutput(), await createOutput())
        return { started: false }
      })

      await harness.controller.startForMetadata(METADATA, 2)

      expect(outputs.map((output) => output.recordingFormat)).toEqual([
        'mp4',
        'mp4',
      ])
      expect(outputs[0]?.recordingPath).toMatch(/_part1\.mp4$/u)
      expect(
        harness.logs.filter((entry) =>
          entry.message.includes('VP9-in-MP4 artifacts'),
        ),
      ).toHaveLength(1)
    })
  })

  it('captures WebM while reserving an MP4 destination for transcoding', async () => {
    await withTempDir(async (tempDir) => {
      const harness = createHarness({
        outputDir: tempDir,
        processing: {
          format: 'mp4',
          transcode: { enabled: true },
        },
      })
      harness.session.setBrowser({} as Browser)
      harness.shouldTranscode.mockReturnValue(true)
      let output:
        | Awaited<
            ReturnType<
              Parameters<
                RecordingControllerOptions['captureEngine']['startCapture']
              >[0]['createOutput']
            >
          >
        | undefined
      harness.startCapture.mockImplementation(async ({ createOutput }) => {
        output = await createOutput()
        return { started: false }
      })

      await harness.controller.startForMetadata(METADATA, 2)

      expect(output).toMatchObject({
        outputFormat: 'mp4',
        recordingFormat: 'webm',
        transcodeEnabled: true,
      })
      expect(output?.recordingPath).toMatch(/_part1\.webm$/u)
      expect(output?.outputPath).toMatch(/_part1\.mp4$/u)
      expect(
        harness.logs.some((entry) =>
          entry.message.includes('VP9-in-MP4 artifacts'),
        ),
      ).toBe(false)
    })
  })

  it('releases the recording slot before finalizing a stopped segment', async () => {
    const harness = createHarness()
    const order: string[] = []
    const segment = createActiveSegment('capture.webm')
    harness.session.beginRecording('capture')
    harness.session.attachCapture({
      recorder: {} as ScreencastRecorder,
      segment,
      windowHandle: undefined,
    })
    harness.setSlotOwned(true)
    harness.releaseSlot.mockImplementation(async () => {
      order.push('release')
      harness.setSlotOwned(false)
    })
    vi.spyOn(harness.media, 'finalizeSegment').mockImplementation(
      async (activeSegment) => {
        expect(activeSegment).toBe(segment)
        order.push('finalize')
      },
    )

    await harness.controller.stopRecording()

    expect(order).toEqual(['release', 'finalize'])
    expect(harness.releaseSlot).toHaveBeenCalledOnce()
  })

  it('warns when a stopped capture stream is incomplete', async () => {
    const harness = createHarness()
    const segment = createActiveSegment('incomplete.webm')
    harness.session.beginRecording('capture')
    harness.session.attachCapture({
      recorder: {} as ScreencastRecorder,
      segment,
      windowHandle: undefined,
    })
    harness.setSlotOwned(true)
    vi.mocked(harness.captureEngine.stopCapture).mockImplementation(
      async () => {
        harness.session.detachCapture()
        return { segment, streamOk: false }
      },
    )
    vi.spyOn(harness.media, 'finalizeSegment').mockResolvedValue(undefined)

    await harness.controller.stopRecording()

    expect(
      harness.logs.some((entry) =>
        entry.message.includes('did not finish cleanly'),
      ),
    ).toBe(true)
  })

  it('releases the slot when capture stops without a segment', async () => {
    const harness = createHarness()
    harness.session.beginRecording('capture')
    harness.session.attachCapture({
      recorder: {} as ScreencastRecorder,
      segment: createActiveSegment('missing.webm'),
      windowHandle: undefined,
    })
    harness.setSlotOwned(true)
    vi.mocked(harness.captureEngine.stopCapture).mockImplementation(
      async () => {
        harness.session.detachCapture()
        return { segment: undefined, streamOk: true }
      },
    )

    await harness.controller.stopRecording()

    expect(harness.media.pendingTaskCount).toBe(0)
    expect(harness.releaseSlot).toHaveBeenCalledOnce()
  })

  const overload =
    'The encoder fell behind the screencast (1024 frames waiting for the encoder reached the limit of 1024); capture stopped after 40.0s to bound memory.'
  const earlyExit =
    'FFmpeg exited with code 0 before the recording was stopped.'

  it.each([
    { failurePolicy: 'warn', reason: undefined },
    { failurePolicy: 'error', reason: undefined },
    { failurePolicy: 'warn', reason: overload },
    { failurePolicy: 'error', reason: overload },
  ] as const)(
    'records an unclean retained stream as failed with $failurePolicy and reason=$reason',
    async ({ failurePolicy, reason }) => {
      await withTempDir(async (tempDir) => {
        const options = { failurePolicy, outputDir: tempDir }
        const harness = createHarness(options)
        const recordingPath = path.join(tempDir, 'partial.webm')
        await fs.writeFile(recordingPath, 'recoverable-partial-media')
        harness.session.beginRecording('partial')
        harness.session.attachCapture({
          recorder: {} as ScreencastRecorder,
          segment: createActiveSegment(recordingPath),
          windowHandle: undefined,
        })
        harness.setSlotOwned(true)
        // A stream can be unclean without a recorder reason, for example
        // after a write error or a stop timeout.
        vi.mocked(harness.captureEngine.stopCapture).mockImplementation(
          async () => ({
            ...harness.session.detachCapture(),
            ...(reason ? { incompleteReason: reason } : {}),
            streamOk: false,
          }),
        )
        const failure = `Recording stream did not finish cleanly for: ${recordingPath}${reason ? ` (${reason})` : ''}`
        const completeCurrent = vi.fn(async () => 'entry')
        const attachRetainedVideos = vi.fn(async () => ({ attachedPaths: [] }))
        const coordinator = createEntityCoordinator(
          harness,
          options,
          { completeCurrent },
          attachRetainedVideos,
        )

        const outcome = coordinator.endEntity({
          manifestResult: 'failed',
          passed: false,
        })
        if (failurePolicy === 'error') {
          await expect(outcome).rejects.toThrow(failure)
        } else {
          await expect(outcome).resolves.toBeUndefined()
        }
        expect(completeCurrent).toHaveBeenCalledWith({
          decision: 'failed',
          paths: [recordingPath],
          processingOperation: 'capture',
          processingOutcome: 'failed',
          reason: 'capture-incomplete',
          result: 'failed',
        })
        // The partial file is still what a failing test's report should show.
        expect(attachRetainedVideos).toHaveBeenCalledWith(
          [recordingPath],
          false,
        )
        expect(harness.logs.filter((entry) => entry.level !== 'debug')).toEqual(
          [
            expect.objectContaining({
              level: 'warn',
              message: `[WdioPuppeteerVideoService] ${failure}`,
            }),
            ...(failurePolicy === 'error'
              ? [expect.objectContaining({ level: 'error' })]
              : []),
          ],
        )
        expect(await fs.readFile(recordingPath, 'utf8')).toBe(
          'recoverable-partial-media',
        )
      })
    },
  )

  it.each(
    (['warn', 'error'] as const).flatMap((failurePolicy) =>
      [true, false].flatMap((keepArtifacts) =>
        [
          { cause: 'overload', reason: overload },
          { cause: 'early encoder exit', reason: earlyExit },
          { cause: 'nothing', reason: undefined },
        ].map((row) => ({ ...row, failurePolicy, keepArtifacts })),
      ),
    ),
  )(
    'reports a capture failed by $cause through the real engine with $failurePolicy and retention=$keepArtifacts',
    async ({ failurePolicy, keepArtifacts, reason }) => {
      await withTempDir(async (tempDir) => {
        const options = { failurePolicy, outputDir: tempDir }
        const harness = createHarness(options, createRealCaptureEngine(options))
        const resetRecording = vi.spyOn(harness.captureEngine, 'resetRecording')
        const recordingPath = path.join(tempDir, 'partial.webm')
        await fs.writeFile(recordingPath, 'recoverable-partial-media')
        harness.session.beginRecording('partial')
        const recorder = attachControlledCapture(
          harness.session,
          recordingPath,
          reason,
        )
        harness.setSlotOwned(true)
        const completeCurrent = vi.fn(async () => 'entry')
        const attachRetainedVideos = vi.fn(async () => ({ attachedPaths: [] }))
        const coordinator = createEntityCoordinator(
          harness,
          options,
          { completeCurrent },
          attachRetainedVideos,
        )
        const failure = keepArtifacts
          ? `Recording stream did not finish cleanly for: ${recordingPath} (${reason})`
          : `Discarded recording was incomplete (${reason})`

        // Retention keeps a failing test's video and discards a passing one's.
        const outcome = coordinator.endEntity({
          manifestResult: keepArtifacts ? 'failed' : 'passed',
          passed: !keepArtifacts,
        })
        if (reason && failurePolicy === 'error') {
          await expect(outcome).rejects.toThrow(failure)
        } else {
          await expect(outcome).resolves.toBeUndefined()
        }

        // Kept media drains through a graceful stop; discarded media is
        // aborted without one, whether or not its capture had failed.
        expect(recorder.stop).toHaveBeenCalledTimes(keepArtifacts ? 1 : 0)
        expect(recorder.abort).toHaveBeenCalledTimes(keepArtifacts ? 0 : 1)
        const paths = keepArtifacts ? [recordingPath] : []
        if (reason) {
          expect(completeCurrent).toHaveBeenCalledWith({
            decision: 'failed',
            paths,
            processingOperation: 'capture',
            processingOutcome: 'failed',
            reason: 'capture-incomplete',
            result: keepArtifacts ? 'failed' : 'passed',
          })
        } else {
          expect(completeCurrent).toHaveBeenCalledWith(
            expect.objectContaining({
              decision: keepArtifacts ? 'recorded' : 'discarded',
              paths,
            }),
          )
        }
        expect(attachRetainedVideos).toHaveBeenCalledWith(paths, !keepArtifacts)
        // One warning for a failed capture, naming its cause; none otherwise.
        expect(harness.logs.filter((entry) => entry.level !== 'debug')).toEqual(
          reason
            ? [
                expect.objectContaining({
                  level: 'warn',
                  message: `[WdioPuppeteerVideoService] ${failure}`,
                }),
                ...(failurePolicy === 'error'
                  ? [expect.objectContaining({ level: 'error' })]
                  : []),
              ]
            : [],
        )
        // The slot is free before the entry completes, and the policy error
        // follows cleanup.
        expect(harness.releaseSlot.mock.invocationCallOrder[0]).toBeLessThan(
          completeCurrent.mock.invocationCallOrder[0] as number,
        )
        expect(completeCurrent.mock.invocationCallOrder[0]).toBeLessThan(
          resetRecording.mock.invocationCallOrder[0] as number,
        )
        expect(harness.session.isRecordingActive).toBe(false)
        expect(harness.media.pendingTaskCount).toBe(0)
        if (keepArtifacts) {
          expect(await fs.readFile(recordingPath, 'utf8')).toBe(
            'recoverable-partial-media',
          )
        } else {
          await expect(fs.stat(recordingPath)).rejects.toMatchObject({
            code: 'ENOENT',
          })
        }

        // Failure state must not leak into the next entity after reset.
        harness.session.beginRecording('next')
        await expect(
          harness.controller.finalizeMedia(true, false),
        ).resolves.toEqual({ deferred: false, paths: [] })
      })
    },
  )

  it.each(['after-test', 'after-worker'] as const)(
    'does not merge or queue incomplete media after a mid-test stop with timing=%s',
    async (timing) => {
      await withTempDir(async (tempDir) => {
        const harness = createHarness({
          processing: { timing, merge: { enabled: true } },
        })
        const recordingPath = path.join(tempDir, 'partial.webm')
        await fs.writeFile(recordingPath, 'partial-media')
        harness.session.beginRecording('partial')
        harness.session.attachCapture({
          recorder: {} as ScreencastRecorder,
          segment: createActiveSegment(recordingPath),
          windowHandle: undefined,
        })
        vi.mocked(harness.captureEngine.stopCapture).mockImplementation(
          async () => ({ ...harness.session.detachCapture(), streamOk: false }),
        )
        const merge = vi.spyOn(harness.media, 'mergeCurrentSegments')
        const queue = vi.spyOn(harness.media, 'queueDeferredMerge')
        await harness.controller.stopRecording()
        const healthyPath = path.join(tempDir, 'healthy.webm')
        await fs.writeFile(healthyPath, 'healthy-media')
        harness.session.advanceSegment()
        harness.session.attachCapture({
          recorder: {} as ScreencastRecorder,
          segment: createActiveSegment(healthyPath),
          windowHandle: undefined,
        })
        vi.mocked(harness.captureEngine.stopCapture).mockImplementation(
          async () => ({ ...harness.session.detachCapture(), streamOk: true }),
        )
        harness.media.enqueue({
          kind: 'transcode',
          inputPath: recordingPath,
          outputPath: 'partial.mp4',
          deleteOriginal: true,
        })

        await expect(
          harness.controller.finalizeMedia(false, true),
        ).resolves.toEqual({
          captureFailure: `Recording stream did not finish cleanly for: ${recordingPath}`,
          deferred: false,
          paths: [recordingPath, healthyPath],
        })
        expect(merge).not.toHaveBeenCalled()
        expect(queue).not.toHaveBeenCalled()
        expect(harness.media.pendingTaskCount).toBe(0)
        expect(harness.session.recordedPaths).toEqual([
          recordingPath,
          healthyPath,
        ])
        expect(await fs.readFile(recordingPath, 'utf8')).toBe('partial-media')
        expect(await fs.readFile(healthyPath, 'utf8')).toBe('healthy-media')
      })
    },
  )

  it('reset clears recording state and releases held slots', async () => {
    const harness = createHarness()
    harness.session.beginRecording('active')
    harness.session.advanceSegment()
    harness.session.setWindowHandle('window-1')
    harness.session.addRecordedPath('segment.webm')
    harness.setSlotOwned(true)

    await harness.controller.reset()

    expect(harness.captureEngine.resetRecording).toHaveBeenCalledOnce()
    expect(harness.session.isRecordingActive).toBe(false)
    expect(harness.session.currentSegment).toBe(0)
    expect(harness.session.currentWindowHandle).toBeUndefined()
    expect(harness.session.recordedPaths).toEqual([])
    expect(harness.releaseSlot).toHaveBeenCalledOnce()
  })
})
