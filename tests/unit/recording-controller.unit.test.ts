import type { WriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ScreenRecorder } from 'puppeteer-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Browser } from 'webdriverio'
import { nodeFileSystem } from '../../src/service/boundaries.js'
import { CaptureSession } from '../../src/service/capture-session.js'
import type { ActiveSegment } from '../../src/service/constants.js'
import type { ServiceLogger } from '../../src/service/logging.js'
import type { MediaPipeline } from '../../src/service/media-pipeline.js'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import {
  RecordingController,
  type RecordingControllerOptions,
} from '../../src/service/recording-controller.js'
import { RecordingMediaCoordinator } from '../../src/service/recording-media-coordinator.js'
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
}

const createHarness = (
  serviceOptions: WdioPuppeteerVideoServiceOptions = {},
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
  const captureEngine: RecordingControllerOptions['captureEngine'] = {
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
  const mediaPipeline: Pick<
    MediaPipeline,
    'merge' | 'reportFailure' | 'transcode'
  > = {
    merge: vi.fn(async () => undefined),
    reportFailure: vi.fn(),
    transcode: vi.fn(async () => undefined),
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
        dimensions: { height: 720, width: 1280 },
        recorder: {} as ScreenRecorder,
        segment: createActiveSegment('active.webm'),
        windowHandle: 'window-1',
      })
      return {
        dimensions: { height: 720, width: 1280 },
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
      dimensions: undefined,
      recorder: {} as ScreenRecorder,
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
      dimensions: undefined,
      recorder: {} as ScreenRecorder,
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
      dimensions: undefined,
      recorder: {} as ScreenRecorder,
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
