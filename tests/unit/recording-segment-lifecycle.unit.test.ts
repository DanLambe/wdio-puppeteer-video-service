import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Browser } from 'webdriverio'
import { nodeFileSystem } from '../../src/service/boundaries.js'
import { CaptureSession } from '../../src/service/capture-session.js'
import type { ActiveSegment } from '../../src/service/constants.js'
import type { ServiceLogger } from '../../src/service/logging.js'
import type { MediaPipeline } from '../../src/service/media-pipeline.js'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import type {
  CaptureStartOptions,
  CaptureStopResult,
} from '../../src/service/puppeteer-capture-engine.js'
import {
  RecordingController,
  type RecordingControllerOptions,
} from '../../src/service/recording-controller.js'
import { RecordingMediaCoordinator } from '../../src/service/recording-media-coordinator.js'
import type { ScreencastRecorder } from '../../src/service/screencast-recorder.js'
import {
  type RecordingAllurePort,
  type RecordingManifestPort,
  WorkerRecordingCoordinator,
} from '../../src/service/worker-recording-coordinator.js'
import type { WdioPuppeteerVideoServiceOptions } from '../../src/types.js'
import type { SlugMetadata } from '../../src/video-name-utils.js'

// Output paths are reserved on disk; the fake engine writes them itself.
vi.mock('../../src/service/artifact-integrity.js', async (load) => {
  const actual =
    await load<typeof import('../../src/service/artifact-integrity.js')>()
  return { ...actual, reserveArtifactPath: async (target: string) => target }
})

const METADATA: SlugMetadata = {
  fileToken: 'segments_spec',
  hashInput: 'segments|holds|0',
  retryToken: '',
  testNameToken: 'holds segments',
}

type LogCall = Readonly<{
  level: Parameters<ServiceLogger>[0]
  message: string
}>

let outputDir = ''

beforeEach(async () => {
  outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-segment-life-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(outputDir, { force: true, recursive: true })
})

const listOutput = async (): Promise<string[]> =>
  (await fs.readdir(outputDir)).sort((left, right) => left.localeCompare(right))

const exists = async (filePath: string): Promise<boolean> =>
  fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false)

/**
 * A live capture over real files: each segment's encoder output is written at
 * start, and stopping it finishes that file, as the real engine does. MP4
 * transcodes and merges write their outputs without FFmpeg.
 */
const createHarness = (serviceOptions: WdioPuppeteerVideoServiceOptions) => {
  const options = { ...serviceOptions, outputDir }
  const resolved = resolveServiceConfiguration(options, 'linux')
  const session = new CaptureSession()
  session.setBrowser({} as Browser)
  const logs: LogCall[] = []
  const log: ServiceLogger = (level, message) => {
    logs.push({ level, message })
  }
  const engine = { current: 'tab-a', uncleanParts: new Set<number>() }
  const startCapture = vi.fn(async (start: CaptureStartOptions) => {
    const output = await start.createOutput()
    await fs.writeFile(output.recordingPath, `frames-${output.recordingPath}`)
    session.attachCapture({
      recorder: {} as ScreencastRecorder,
      segment: {
        outputFormat: output.outputFormat,
        outputPath: output.outputPath,
        recordingFormat: output.recordingFormat,
        recordingPath: output.recordingPath,
        transcode: output.transcodeEnabled,
        transcodeOptions: start.transcodeOptions,
      },
      windowHandle: start.target?.contextId ?? engine.current,
      ...(start.target?.reason ? { reason: start.target.reason } : {}),
    })
    return { started: true }
  })
  const stopCapture = vi.fn(
    async (
      stop: Readonly<{ discard?: boolean }> = {},
    ): Promise<CaptureStopResult> => {
      const part = session.currentSegment
      const { segment } = session.detachCapture()
      if (!segment) {
        return { capturedSeconds: 0, segment: undefined, streamOk: false }
      }
      if (stop.discard) {
        await fs.rm(segment.recordingPath, { force: true })
        return { capturedSeconds: 0, segment: undefined, streamOk: true }
      }
      if (!engine.uncleanParts.has(part)) {
        return { capturedSeconds: 0, segment, streamOk: true }
      }
      segment.transcode = false
      segment.outputPath = segment.recordingPath
      segment.outputFormat = segment.recordingFormat
      return {
        capturedSeconds: 0,
        incompleteReason: 'encoder exited',
        segment,
        streamOk: false,
      }
    },
  )
  const captureEngine: RecordingControllerOptions['captureEngine'] = {
    afterWindowCommand: vi.fn(async () => {}),
    beforeWindowCommand: vi.fn(async () => {}),
    currentWindowHandle: vi.fn(async () => engine.current),
    discardSpool: vi.fn(async () => {}),
    isRecordedPageClosed: false,
    resetRecording: vi.fn(async () => {
      session.detachCapture()
      session.resetRecording()
      return {}
    }),
    startCapture,
    stopCapture,
  }
  const ffmpegRuntime: RecordingControllerOptions['ffmpegRuntime'] = {
    ensureReady: vi.fn(async () => true),
    resolvePath: vi.fn(() => 'ffmpeg'),
    shouldTranscode: vi.fn(
      (format) =>
        format === 'mp4' && resolved.options.processing.transcode.enabled,
    ),
  }
  const transcode = vi.fn<MediaPipeline['transcode']>(async (request) => {
    await fs.writeFile(request.outputPath, 'h264')
    if (request.deleteOriginal) {
      await fs.rm(request.inputPath, { force: true })
    }
    return request.outputPath
  })
  const merge = vi.fn<MediaPipeline['merge']>(async (request) => {
    await fs.writeFile(request.mergedPath, 'merged')
    if (request.deleteSegments) {
      await Promise.all(
        request.segmentPaths.map((segmentPath) =>
          fs.rm(segmentPath, { force: true }),
        ),
      )
    }
    return request.mergedPath
  })
  const reportFailure = vi.fn<MediaPipeline['reportFailure']>((message) => {
    if (resolved.options.failurePolicy === 'error') {
      throw new Error(`[WdioPuppeteerVideoService] ${message}`)
    }
  })
  const media = new RecordingMediaCoordinator({
    captureSession: session,
    ffmpegRuntime,
    fileSystem: nodeFileSystem,
    getManifestRecorder: () => undefined,
    log,
    mediaPipeline: { merge, reportFailure, transcode },
    options: resolved.options,
  })
  const finalizeSegment = vi.spyOn(media, 'finalizeSegment')
  const releaseSlot = vi.fn(async () => {})
  const controller = new RecordingController({
    captureEngine,
    captureSession: session,
    ffmpegRuntime,
    getManifestRecorder: () => undefined,
    log,
    maxSlugLength: resolved.maxSlugLength,
    media,
    options: resolved.options,
    recordingSlotScheduler: {
      acquire: vi.fn(async () => true),
      ownsGlobalRecordingSlot: false,
      ownsRecordingSlot: false,
      release: releaseSlot,
    },
  })
  const segmentPath = (part: number, format: string): string =>
    path.join(outputDir, `${session.currentTestSlug}_part${part}.${format}`)
  const partsOf = (
    calls: ReadonlyArray<readonly [ActiveSegment, ...unknown[]]>,
  ) => calls.map(([segment]) => path.basename(segment.recordingPath))
  /** Records three tabs: a, then b, then a again. */
  const recordThreeTabs = async (): Promise<void> => {
    await controller.startForMetadata(METADATA, 0)
    await controller.followContext('tab-b', 'command')
    await controller.followContext('tab-a', 'switch-to-window')
  }
  return {
    controller,
    engine,
    finalizeSegment,
    logs,
    media,
    merge,
    partsOf,
    recordThreeTabs,
    releaseSlot,
    reportFailure,
    resolved,
    segmentPath,
    session,
    stopCapture,
    transcode,
  }
}

type Harness = ReturnType<typeof createHarness>

/**
 * The worker coordinator over a harness's controller, with a manifest and an
 * Allure port that record what they are given.
 */
const createReportingCoordinator = (
  harness: Harness,
  attachRetainedVideos: RecordingAllurePort['attachRetainedVideos'] = async (
    paths,
  ) => ({ attachedPaths: [...paths] }),
) => {
  const completeCurrent = vi.fn<RecordingManifestPort['completeCurrent']>(
    async () => 'entry',
  )
  const attach = vi.fn(attachRetainedVideos)
  const reset = vi.spyOn(harness.controller, 'reset')
  const coordinator = new WorkerRecordingCoordinator({
    actions: {
      finalizeMedia: (passed, keep) =>
        harness.controller.finalizeMedia(passed, keep),
      finalizeMediaWithoutOutcome: () =>
        harness.controller.finalizeWithoutOutcome(),
      getAvailability: () => ({ available: true }),
      getRecordedPaths: () => harness.session.filePaths,
      isRecordingActive: () => harness.session.isRecordingActive,
      resetRecording: () => harness.controller.reset(),
      runSerialized: (task) => harness.controller.runSerialized(task),
      startRecording: (metadata, retry) =>
        harness.controller.startForMetadata(metadata, retry),
    },
    allure: { attachRetainedVideos: attach },
    getLogLevel: () => 'warn',
    log: vi.fn(),
    options: harness.resolved.options,
  })
  coordinator.configureSession({
    framework: 'mocha',
    specFileRetryAttempt: 0,
    manifest: {
      currentEntryId: 'entry',
      beginEntity: async () => 'entry',
      completeCurrent,
      recordResult: async () => {},
      recordSkippedEntity: async () => 'entry',
      setCurrentAttempt: () => {},
    },
  })
  const endFailedTest = () =>
    coordinator.endEntity({ manifestResult: 'failed', passed: false })
  return { attach, completeCurrent, endFailedTest, reset }
}

const THREE_TABS = new Map([
  [1, { contextId: 'tab-a', ordinal: 1, reason: 'start' }],
  [2, { contextId: 'tab-b', ordinal: 2, reason: 'command' }],
  [3, { contextId: 'tab-a', ordinal: 1, reason: 'switch-to-window' }],
])

const MP4 = {
  format: 'mp4',
  transcode: { enabled: true, deleteOriginal: true },
} as const

describe('Segment life cycle', () => {
  it('holds mid-test segments without transcoding or merging them', async () => {
    const harness = createHarness({
      processing: { ...MP4, merge: { enabled: true } },
    })

    await harness.recordThreeTabs()

    expect(harness.finalizeSegment).not.toHaveBeenCalled()
    expect(harness.transcode).not.toHaveBeenCalled()
    expect(harness.merge).not.toHaveBeenCalled()
    expect(harness.media.pendingTaskCount).toBe(0)
    expect(harness.session.recordedPaths).toEqual([])
    expect(
      harness.session.heldSegments.map((held) => ({
        clean: held.clean,
        part: held.part,
        recordingPath: held.segment.recordingPath,
        outputPath: held.segment.outputPath,
        tab: held.tab?.contextId,
        transcode: held.segment.transcode,
      })),
    ).toEqual([
      {
        clean: true,
        part: 1,
        recordingPath: harness.segmentPath(1, 'webm'),
        outputPath: harness.segmentPath(1, 'mp4'),
        tab: 'tab-a',
        transcode: true,
      },
      {
        clean: true,
        part: 2,
        recordingPath: harness.segmentPath(2, 'webm'),
        outputPath: harness.segmentPath(2, 'mp4'),
        tab: 'tab-b',
        transcode: true,
      },
    ])
    // Each stop frees its recording slot as before.
    expect(harness.releaseSlot).toHaveBeenCalledTimes(2)
    // The encoder's files are complete and still on disk.
    expect(harness.session.filePaths).toEqual([
      harness.segmentPath(1, 'webm'),
      harness.segmentPath(2, 'webm'),
    ])
    expect(await listOutput()).toHaveLength(3)
  })

  it('finalizes every held segment in part order, then merges, when kept', async () => {
    const harness = createHarness({
      processing: { ...MP4, merge: { enabled: true, deleteSegments: true } },
    })
    await harness.recordThreeTabs()

    const finalized = await harness.controller.finalizeMedia(false, true)

    expect(harness.partsOf(harness.finalizeSegment.mock.calls)).toEqual([
      path.basename(harness.segmentPath(1, 'webm')),
      path.basename(harness.segmentPath(2, 'webm')),
      path.basename(harness.segmentPath(3, 'webm')),
    ])
    expect(
      harness.transcode.mock.calls.map(([request]) => request.inputPath),
    ).toEqual([1, 2, 3].map((part) => harness.segmentPath(part, 'webm')))
    expect(harness.merge).toHaveBeenCalledOnce()
    expect(harness.merge.mock.calls[0]?.[0].segmentPaths).toEqual(
      [1, 2, 3].map((part) => harness.segmentPath(part, 'mp4')),
    )
    // Every transcode came before the merge.
    expect(
      Math.max(...harness.transcode.mock.invocationCallOrder),
    ).toBeLessThan(harness.merge.mock.invocationCallOrder[0] as number)
    const mergedPath = path.join(
      outputDir,
      `${harness.session.currentTestSlug}.mp4`,
    )
    expect(finalized).toEqual({
      deferred: false,
      paths: [mergedPath],
      tabs: new Map([
        [1, { contextId: 'tab-a', ordinal: 1, reason: 'start' }],
        [2, { contextId: 'tab-b', ordinal: 2, reason: 'command' }],
        [3, { contextId: 'tab-a', ordinal: 1, reason: 'switch-to-window' }],
      ]),
    })
    expect(harness.session.heldSegments).toEqual([])
    expect(await listOutput()).toEqual([path.basename(mergedPath)])
  })

  it('keeps each transcoded segment and its tab when kept without merging', async () => {
    const harness = createHarness({ processing: MP4 })
    await harness.recordThreeTabs()

    const finalized = await harness.controller.finalizeMedia(false, true)

    const outputs = [1, 2, 3].map((part) => harness.segmentPath(part, 'mp4'))
    expect(finalized.paths).toEqual(outputs)
    expect([...(finalized.tabs?.keys() ?? [])]).toEqual([1, 2, 3])
    expect(harness.merge).not.toHaveBeenCalled()
    expect(await listOutput()).toEqual(
      outputs.map((file) => path.basename(file)),
    )
  })

  it('deletes every held file and runs no FFmpeg work when discarded', async () => {
    const harness = createHarness({
      processing: { ...MP4, merge: { enabled: true } },
    })
    await harness.recordThreeTabs()

    await expect(
      harness.controller.finalizeMedia(true, false),
    ).resolves.toEqual({ deferred: false, paths: [] })

    expect(harness.finalizeSegment).not.toHaveBeenCalled()
    expect(harness.transcode).not.toHaveBeenCalled()
    expect(harness.merge).not.toHaveBeenCalled()
    expect(harness.stopCapture).toHaveBeenLastCalledWith({ discard: true })
    expect(harness.session.heldSegments).toEqual([])
    expect(harness.media.pendingTaskCount).toBe(0)
    expect(await listOutput()).toEqual([])
  })

  it('finalizes a recording without an outcome as kept, without merging', async () => {
    const harness = createHarness({
      processing: { ...MP4, merge: { enabled: true } },
    })
    await harness.recordThreeTabs()

    await harness.controller.finalizeWithoutOutcome()

    expect(harness.session.hasCapture).toBe(false)
    expect(harness.session.heldSegments).toEqual([])
    expect(harness.partsOf(harness.finalizeSegment.mock.calls)).toHaveLength(3)
    expect(harness.transcode).toHaveBeenCalledTimes(3)
    // As before, only the test's end merges.
    expect(harness.merge).not.toHaveBeenCalled()
    expect(harness.session.recordedPaths).toEqual(
      [1, 2, 3].map((part) => harness.segmentPath(part, 'mp4')),
    )
  })

  it.each([
    { timing: 'after-test', merge: true },
    { timing: 'after-worker', merge: true },
    { timing: 'after-test', merge: false },
    { timing: 'after-worker', merge: false },
  ] as const)(
    'keeps an unclean held segment as unprocessed media with timing=$timing merge=$merge',
    async ({ timing, merge }) => {
      const harness = createHarness({
        processing: { ...MP4, timing, merge: { enabled: merge } },
      })
      harness.engine.uncleanParts.add(2)
      await harness.recordThreeTabs()
      const failure = `Recording stream did not finish cleanly for: ${harness.segmentPath(2, 'webm')} (encoder exited)`
      // The failure is reported when the segment stops, not at the end.
      expect(harness.logs).toContainEqual({
        level: 'warn',
        message: `[WdioPuppeteerVideoService] ${failure}`,
      })
      expect(harness.session.heldSegments.map((held) => held.clean)).toEqual([
        true,
        false,
      ])

      const finalized = await harness.controller.finalizeMedia(false, true)
      const deferred = timing === 'after-worker'
      expect(finalized).toMatchObject({ captureFailure: failure, deferred })
      // After-worker transcodes the same segments, once the worker ends.
      expect(harness.media.pendingTaskCount).toBe(deferred ? 2 : 0)
      await harness.media.flush()

      // Healthy segments are transcoded at either timing; the unclean one
      // never is, and nothing is merged.
      expect(
        harness.transcode.mock.calls.map(([request]) => request.inputPath),
      ).toEqual([
        harness.segmentPath(1, 'webm'),
        harness.segmentPath(3, 'webm'),
      ])
      expect(harness.merge).not.toHaveBeenCalled()
      expect(harness.media.pendingTaskCount).toBe(0)
      for (const file of [
        harness.segmentPath(1, 'mp4'),
        harness.segmentPath(2, 'webm'),
        harness.segmentPath(3, 'mp4'),
      ]) {
        expect(await exists(file), file).toBe(true)
      }
    },
  )

  it('never processes a task that touches an unclean segment', async () => {
    const harness = createHarness({
      processing: { ...MP4, timing: 'after-worker' },
    })
    harness.engine.uncleanParts.add(2)
    await harness.recordThreeTabs()
    harness.media.enqueue({
      kind: 'transcode',
      inputPath: harness.segmentPath(2, 'webm'),
      outputPath: harness.segmentPath(2, 'mp4'),
      deleteOriginal: true,
    })

    await harness.controller.finalizeMedia(false, true)

    expect(
      harness.media.pendingTasks.map((task) =>
        task.kind === 'transcode' ? task.inputPath : task.mergedPath,
      ),
    ).toEqual([harness.segmentPath(1, 'webm'), harness.segmentPath(3, 'webm')])
  })

  it('transcodes the healthy parts of an interrupted after-worker recording that would have been merged', async () => {
    const harness = createHarness({
      processing: { ...MP4, timing: 'after-worker', merge: { enabled: true } },
    })
    await harness.recordThreeTabs()

    const finalized = await harness.controller.finalizeWithoutOutcome()
    expect(finalized.deferred).toBe(true)
    await harness.media.flush()

    expect(harness.merge).not.toHaveBeenCalled()
    expect(
      harness.transcode.mock.calls.map(([request]) => request.inputPath),
    ).toEqual([1, 2, 3].map((part) => harness.segmentPath(part, 'webm')))
  })

  it('reports a held capture failure and deletes its file when discarded', async () => {
    const harness = createHarness({ processing: MP4 })
    harness.engine.uncleanParts.add(1)
    await harness.recordThreeTabs()

    const finalized = await harness.controller.finalizeMedia(true, false)

    expect(finalized).toEqual({
      captureFailure: `Recording stream did not finish cleanly for: ${harness.segmentPath(1, 'webm')} (encoder exited)`,
      deferred: false,
      paths: [],
    })
    expect(harness.transcode).not.toHaveBeenCalled()
    expect(await listOutput()).toEqual([])
  })

  it.each([
    { merge: false, kinds: ['transcode', 'transcode', 'transcode'] },
    { merge: true, kinds: ['merge'] },
  ])(
    'queues the same deferred tasks at the end under after-worker with merge=$merge',
    async ({ merge, kinds }) => {
      const harness = createHarness({
        processing: {
          ...MP4,
          timing: 'after-worker',
          merge: { enabled: merge },
        },
      })
      await harness.recordThreeTabs()
      expect(harness.media.pendingTaskCount).toBe(0)

      const finalized = await harness.controller.finalizeMedia(false, true)

      const inputs = [1, 2, 3].map((part) => harness.segmentPath(part, 'webm'))
      expect(harness.transcode).not.toHaveBeenCalled()
      expect(finalized.deferred).toBe(true)
      expect(finalized.paths).toEqual(inputs)
      const tasks = harness.media.pendingTasks
      expect(tasks.map((task) => task.kind)).toEqual(kinds)
      if (merge) {
        expect(tasks[0]).toMatchObject({ segmentPaths: inputs })
      } else {
        expect(tasks).toEqual(
          [1, 2, 3].map((part) =>
            expect.objectContaining({
              inputPath: harness.segmentPath(part, 'webm'),
              outputPath: harness.segmentPath(part, 'mp4'),
            }),
          ),
        )
      }
    },
  )

  it('drops held segments on reset, keeping their files, and starts clean', async () => {
    const harness = createHarness({ processing: MP4 })
    await harness.recordThreeTabs()
    const held = [1, 2].map((part) => harness.segmentPath(part, 'webm'))

    await harness.controller.reset()

    expect(harness.session.heldSegments).toEqual([])
    expect(harness.session.filePaths).toEqual([])
    expect(harness.logs).toContainEqual({
      level: 'warn',
      message: `[WdioPuppeteerVideoService] Keeping 2 unprocessed recording segment(s): ${held.join(', ')}`,
    })
    for (const file of held) {
      expect(await exists(file)).toBe(true)
    }

    await harness.controller.startForMetadata(METADATA, 0)
    const finalized = await harness.controller.finalizeMedia(false, true)

    expect(harness.transcode).toHaveBeenCalledOnce()
    expect(finalized.paths).toEqual([harness.segmentPath(1, 'mp4')])
  })
})

/** How a segment's transcode fails: it reports failure, or it throws. */
type TranscodeFailure = 'returns' | 'throws'

/**
 * Makes the transcode of one part fail; the others succeed. Returns the error
 * the failure surfaces as.
 */
const failTranscodeOf = (
  harness: Harness,
  part: number,
  mode: TranscodeFailure,
  options: Readonly<{ deleteInput?: boolean }> = {},
): (() => unknown) => {
  const succeed = harness.transcode.getMockImplementation()
  const thrown = new Error(`transcode of part ${part.toString()} crashed`)
  harness.transcode.mockImplementation(async (request) => {
    if (!path.basename(request.inputPath).includes(`_part${part}.`)) {
      return succeed?.(request)
    }
    if (options.deleteInput) {
      await fs.rm(request.inputPath)
    }
    if (mode === 'throws') {
      throw thrown
    }
    return undefined
  })
  return () =>
    mode === 'throws'
      ? thrown
      : harness.reportFailure.mock.results.find(
          (result) => result.type === 'throw',
        )?.value
}

describe('Segment processing failure at the end of a kept recording', () => {
  it.each([
    { part: 1, mode: 'returns' },
    { part: 1, mode: 'throws' },
    // Part 1 is a finished MP4 and parts 2 and 3 remain WebM.
    { part: 2, mode: 'returns' },
    { part: 2, mode: 'throws' },
  ] as const)(
    'reports the files, tabs and attachment when part $part $mode failure',
    async ({ part, mode }) => {
      const harness = createHarness({ failurePolicy: 'error', processing: MP4 })
      const failure = failTranscodeOf(harness, part, mode)
      const reporting = createReportingCoordinator(harness)
      await harness.recordThreeTabs()
      // Parts before the failure are finalized; the rest are the files they are.
      const files = [1, 2, 3].map((each) =>
        harness.segmentPath(each, each < part ? 'mp4' : 'webm'),
      )

      const ended = reporting.endFailedTest()

      await expect(ended).rejects.toThrow()
      const error = failure()
      await expect(ended).rejects.toBe(error)
      expect(reporting.completeCurrent).toHaveBeenCalledOnce()
      expect(reporting.completeCurrent).toHaveBeenCalledWith({
        decision: 'failed',
        paths: files,
        processingOutcome: 'failed',
        reason: (error as Error).message,
        result: 'failed',
        tabs: THREE_TABS,
      })
      expect(reporting.attach).toHaveBeenCalledExactlyOnceWith(files, false)
      for (const file of files) {
        expect(await exists(file)).toBe(true)
      }
      expect(harness.logs).toContainEqual({
        level: 'warn',
        message: `[WdioPuppeteerVideoService] Keeping ${(4 - part).toString()} unprocessed recording segment(s): ${files.slice(part - 1).join(', ')}`,
      })
      expect(reporting.reset).toHaveBeenCalled()
      expect(harness.session.isRecordingActive).toBe(false)
      expect(harness.session.heldSegments).toEqual([])
      // Nothing is merged, queued or transcoded again.
      expect(harness.transcode).toHaveBeenCalledTimes(part)
      expect(harness.media.pendingTaskCount).toBe(0)
      await harness.media.flush()
      expect(harness.transcode).toHaveBeenCalledTimes(part)
      expect(harness.merge).not.toHaveBeenCalled()
    },
  )

  it.each([
    {
      attachment: 'returns an error',
      attach: async () => ({
        attachedPaths: [],
        error: new Error('allure unavailable'),
      }),
    },
    {
      attachment: 'throws',
      attach: async (): Promise<never> => {
        throw new Error('allure crashed')
      },
    },
  ])(
    'throws the processing error when the attachment $attachment',
    async ({ attach }) => {
      const harness = createHarness({ failurePolicy: 'error', processing: MP4 })
      const failure = failTranscodeOf(harness, 2, 'throws')
      const reporting = createReportingCoordinator(harness, attach)
      await harness.recordThreeTabs()

      await expect(reporting.endFailedTest()).rejects.toBe(failure())

      expect(reporting.completeCurrent.mock.calls[0]?.[0]).toMatchObject({
        decision: 'failed',
        tabs: THREE_TABS,
      })
      expect(reporting.attach).toHaveBeenCalledOnce()
      expect(reporting.reset).toHaveBeenCalled()
      expect(harness.session.isRecordingActive).toBe(false)
    },
  )

  it('lists and attaches only the files that still exist', async () => {
    const harness = createHarness({ failurePolicy: 'error', processing: MP4 })
    const failure = failTranscodeOf(harness, 2, 'throws', { deleteInput: true })
    const reporting = createReportingCoordinator(harness)
    await harness.recordThreeTabs()
    const files = [
      harness.segmentPath(1, 'mp4'),
      harness.segmentPath(3, 'webm'),
    ]

    await expect(reporting.endFailedTest()).rejects.toBe(failure())

    expect(reporting.completeCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: files,
        tabs: new Map([
          [1, THREE_TABS.get(1)],
          [3, THREE_TABS.get(3)],
        ]),
      }),
    )
    expect(reporting.attach).toHaveBeenCalledExactlyOnceWith(files, false)
  })

  it('keeps the existing warn-policy report when a transcode reports failure', async () => {
    const harness = createHarness({ processing: MP4 })
    failTranscodeOf(harness, 2, 'returns')
    const reporting = createReportingCoordinator(harness)
    await harness.recordThreeTabs()
    const files = [
      harness.segmentPath(1, 'mp4'),
      harness.segmentPath(2, 'webm'),
      harness.segmentPath(3, 'mp4'),
    ]

    await expect(reporting.endFailedTest()).resolves.toBeUndefined()

    expect(reporting.completeCurrent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        decision: 'recorded',
        paths: files,
        processingOutcome: 'completed',
        tabs: THREE_TABS,
      }),
    )
    expect(reporting.attach).toHaveBeenCalledExactlyOnceWith(files, false)
  })
})
