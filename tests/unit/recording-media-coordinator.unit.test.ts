import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nodeFileSystem, nodeProcess } from '../../src/service/boundaries.js'
import { CaptureSession } from '../../src/service/capture-session.js'
import type {
  ActiveSegment,
  DeferredPostProcessTask,
  DeferredTranscodeTask,
} from '../../src/service/constants.js'
import {
  aggregateManifestRun,
  createManifestRunContext,
  ManifestWorkerRecorder,
} from '../../src/service/manifest-runtime.js'
import { MediaPipeline } from '../../src/service/media-pipeline.js'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import {
  RecordingMediaCoordinator,
  type RecordingMediaCoordinatorOptions,
} from '../../src/service/recording-media-coordinator.js'
import type {
  LogLevel,
  WdioPuppeteerVideoServiceOptions,
} from '../../src/types.js'

interface CoordinatorHarness {
  readonly captureSession: CaptureSession
  readonly coordinator: RecordingMediaCoordinator
  readonly logs: Array<
    Readonly<{ details?: unknown; level: LogLevel; message: string }>
  >
  readonly merge: ReturnType<typeof vi.fn<MediaPipeline['merge']>>
  readonly reportFailure: ReturnType<
    typeof vi.fn<MediaPipeline['reportFailure']>
  >
  readonly transcode: ReturnType<typeof vi.fn<MediaPipeline['transcode']>>
}

const tempDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    tempDirs.splice(0).map((tempDir) =>
      fs.rm(tempDir, { force: true, recursive: true }).catch(() => {
        // Best-effort test cleanup.
      }),
    ),
  )
})

describe('RecordingMediaCoordinator', () => {
  it('queues deferred segment transcoding with the current manifest entry', async () => {
    const tempDir = await createTempDir()
    const recordingPath = path.join(tempDir, 'checkout_part1.webm')
    const outputPath = path.join(tempDir, 'checkout_part1.mp4')
    await fs.writeFile(recordingPath, 'captured-media', 'utf8')
    const recorder = await createManifestRecorder(tempDir)
    await recorder.beginEntity({
      scope: 'test',
      specPaths: ['specs/checkout.ts'],
      test: { title: 'records checkout' },
    })
    const harness = createHarness(
      {
        processing: {
          format: 'mp4',
          timing: 'after-worker',
          transcode: { enabled: true },
        },
      },
      recorder,
    )

    await harness.coordinator.finalizeSegment(
      createSegment(recordingPath, outputPath, true),
    )

    expect(harness.coordinator.shouldDefer).toBe(true)
    expect(harness.captureSession.recordedPaths).toEqual([recordingPath])
    expect(harness.coordinator.pendingTasks).toEqual([
      {
        deleteOriginal: true,
        inputPath: recordingPath,
        kind: 'transcode',
        manifestEntryId: recorder.currentEntryId,
        outputPath,
      },
    ])
    expect(harness.transcode).not.toHaveBeenCalled()
  })

  it('lists every separately transcoded deferred segment in the manifest', async () => {
    const tempDir = await createTempDir()
    const context = await createManifestRunContext(tempDir)
    const recorder = new ManifestWorkerRecorder({
      cid: '0-0',
      context,
      framework: 'mocha',
    })
    await recorder.beginEntity({
      scope: 'test',
      specPaths: ['specs/tabs.ts'],
      test: { title: 'uses two tabs' },
    })
    const harness = createHarness(
      {
        outputDir: tempDir,
        processing: {
          format: 'mp4',
          timing: 'after-worker',
          transcode: { enabled: true },
        },
      },
      recorder,
    )
    harness.transcode.mockImplementation(async ({ outputPath }) => {
      await fs.writeFile(outputPath, 'mp4', 'utf8')
      return outputPath
    })
    harness.captureSession.beginRecording('tabs')
    const recordingPaths = await createInputFiles(tempDir, [
      'tabs_part1.webm',
      'tabs_part2.webm',
    ])
    for (const recordingPath of recordingPaths) {
      await harness.coordinator.finalizeSegment(
        createSegment(
          recordingPath,
          recordingPath.replace('.webm', '.mp4'),
          true,
        ),
      )
    }
    await recorder.completeCurrent({
      decision: 'recorded',
      result: 'passed',
      paths: [...harness.captureSession.recordedPaths],
      processingOutcome: 'pending',
      processingOperation: 'transcode',
    })

    await harness.coordinator.flush()
    await recorder.flush()

    const manifest = await aggregateManifestRun(context, 0)
    const capture = manifest.runs[0]?.entries[0]?.capture
    expect(capture?.segments.map((segment) => segment.path)).toEqual([
      'tabs_part1.mp4',
      'tabs_part2.mp4',
    ])
    expect(capture?.final).toBeUndefined()
  })

  it('keeps both segments when two deferred transcodes finish together', async () => {
    const tempDir = await createTempDir()
    const context = await createManifestRunContext(tempDir)
    const entered = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ]
    const released = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ]
    const recorder = new ManifestWorkerRecorder({
      cid: '0-0',
      context,
      framework: 'mocha',
      // Holds each completion after it read the entry and before it publishes.
      readDimensions: async (filePath) => {
        const index = filePath.includes('_part1.') ? 0 : 1
        entered[index]?.resolve()
        await released[index]?.promise
        return undefined
      },
    })
    await recorder.beginEntity({
      scope: 'test',
      specPaths: ['specs/tabs.ts'],
      test: { title: 'uses two tabs' },
    })
    const harness = createHarness(
      {
        outputDir: tempDir,
        concurrency: { maxPostProcessesPerProcess: 2 },
        processing: {
          format: 'mp4',
          timing: 'after-worker',
          transcode: { enabled: true },
        },
      },
      recorder,
    )
    harness.transcode.mockImplementation(async ({ outputPath }) => {
      await fs.writeFile(outputPath, 'mp4', 'utf8')
      return outputPath
    })
    harness.captureSession.beginRecording('tabs')
    const recordingPaths = await createInputFiles(tempDir, [
      'tabs_part1.webm',
      'tabs_part2.webm',
    ])
    for (const recordingPath of recordingPaths) {
      await harness.coordinator.finalizeSegment(
        createSegment(
          recordingPath,
          recordingPath.replace('.webm', '.mp4'),
          true,
        ),
      )
    }
    await recorder.completeCurrent({
      decision: 'recorded',
      result: 'passed',
      paths: [...harness.captureSession.recordedPaths],
      processingOutcome: 'pending',
      processingOperation: 'transcode',
    })

    const flushed = harness.coordinator.flush()
    await Promise.all(entered.map((gate) => gate.promise))
    released[1]?.resolve()
    released[0]?.resolve()
    await flushed
    await recorder.flush()

    const manifest = await aggregateManifestRun(context, 0)
    const capture = manifest.runs[0]?.entries[0]?.capture
    expect(capture?.segments.map((segment) => segment.path)).toEqual([
      'tabs_part1.mp4',
      'tabs_part2.mp4',
    ])
  })

  it('settles an entry as failed when one of its deferred tasks throws', async () => {
    const tempDir = await createTempDir()
    const context = await createManifestRunContext(tempDir)
    const recorder = new ManifestWorkerRecorder({
      cid: '0-0',
      context,
      framework: 'mocha',
    })
    await recorder.beginEntity({
      scope: 'test',
      specPaths: ['specs/tabs.ts'],
      test: { title: 'uses two tabs' },
    })
    const harness = createHarness(
      {
        outputDir: tempDir,
        processing: {
          format: 'mp4',
          timing: 'after-worker',
          transcode: { enabled: true },
        },
      },
      recorder,
    )
    harness.transcode.mockImplementation(async ({ inputPath, outputPath }) => {
      if (inputPath.includes('_part2.')) {
        throw new Error('encoder crashed')
      }
      await fs.writeFile(outputPath, 'mp4', 'utf8')
      return outputPath
    })
    harness.captureSession.beginRecording('tabs')
    const recordingPaths = await createInputFiles(tempDir, [
      'tabs_part1.webm',
      'tabs_part2.webm',
    ])
    for (const recordingPath of recordingPaths) {
      await harness.coordinator.finalizeSegment(
        createSegment(
          recordingPath,
          recordingPath.replace('.webm', '.mp4'),
          true,
        ),
      )
    }
    await recorder.completeCurrent({
      decision: 'recorded',
      result: 'passed',
      paths: [...harness.captureSession.recordedPaths],
      processingOutcome: 'pending',
      processingOperation: 'transcode',
    })

    await expect(harness.coordinator.flush()).rejects.toThrow('encoder crashed')
    await recorder.flush()

    const entry = (await aggregateManifestRun(context, 0)).runs[0]?.entries[0]
    expect(entry?.capture.segments.map((segment) => segment.path)).toEqual([
      'tabs_part1.mp4',
      'tabs_part2.webm',
    ])
    expect(entry?.processing).toMatchObject({
      outcome: 'failed',
      operation: 'transcode',
      reason: 'deferred-processing-error',
    })
  })

  it.each([
    ['throws', true, 'deferred-processing-error'],
    ['throws', false, 'deferred-processing-error'],
    ['fails', true, 'deferred-transcode-failed-original-preserved'],
    ['fails', false, 'deferred-transcode-failed-original-preserved'],
  ] as const)(
    'lists the merged source when its MP4 transcode %s (deleteSegments: %s)',
    async (failure, deleteSegments, reason) => {
      const { context, coordinator, harness, inputs, mergedPath, recorder } =
        await createMergeScenario(deleteSegments)
      const crash = new Error('encoder crashed')
      harness.transcode.mockImplementation(async () => {
        if (failure === 'throws') {
          throw crash
        }
        return undefined
      })

      if (failure === 'throws') {
        await expect(coordinator.flush()).rejects.toBe(crash)
      } else {
        await coordinator.flush()
      }
      await recorder.flush()

      const entry = (await aggregateManifestRun(context, 0)).runs[0]?.entries[0]
      expect(entry?.capture.segments.map((segment) => segment.path)).toEqual([
        'tabs.webm',
      ])
      expect(
        entry?.capture.segments[0]?.tabs?.map((tab) => tab.reason),
      ).toEqual(['start', 'command'])
      expect(entry?.processing).toMatchObject({
        outcome: 'failed',
        operation: 'transcode',
        reason,
      })
      // Deleted parts are never listed again; kept ones stay on disk.
      for (const input of inputs) {
        await expect(fileExists(input)).resolves.toBe(!deleteSegments)
      }
      await expect(fileExists(mergedPath)).resolves.toBe(true)
    },
  )

  it('lists an MP4 published before its transcode threw', async () => {
    const { context, coordinator, harness, inputs, mergedPath, recorder } =
      await createMergeScenario(true)
    const crash = new Error('could not remove the merged source')
    harness.transcode.mockImplementation(
      async ({ onPublished, outputPath }) => {
        await fs.writeFile(outputPath, 'mp4', 'utf8')
        onPublished?.(outputPath)
        throw crash
      },
    )

    await expect(coordinator.flush()).rejects.toBe(crash)
    await recorder.flush()

    const entry = (await aggregateManifestRun(context, 0)).runs[0]?.entries[0]
    expect(entry?.capture.segments.map((segment) => segment.path)).toEqual([
      'tabs.mp4',
    ])
    expect(entry?.capture.final?.tabs).toHaveLength(2)
    expect(entry?.processing.outcome).toBe('failed')
    expect(inputs).toHaveLength(2)
    await expect(fileExists(mergedPath)).resolves.toBe(true)
  })

  it('lists the surviving segments when the merge itself throws', async () => {
    const { context, coordinator, harness, recorder } =
      await createMergeScenario(true)
    const crash = new Error('merge crashed')
    harness.merge.mockRejectedValue(crash)

    await expect(coordinator.flush()).rejects.toBe(crash)
    await recorder.flush()

    const entry = (await aggregateManifestRun(context, 0)).runs[0]?.entries[0]
    expect(entry?.capture.segments.map((segment) => segment.path)).toEqual([
      'tabs_part1.webm',
      'tabs_part2.webm',
    ])
    expect(entry?.capture.decision).toBe('recorded')
    expect(entry?.processing).toMatchObject({
      outcome: 'failed',
      operation: 'merge',
      reason: 'deferred-processing-error',
    })
  })

  it.each([
    ['transcode', 'after', ['checkout_run2_part1.mp4']],
    ['transcode', 'before', ['checkout_part1.webm']],
    ['merge', 'after', ['checkout_run2.webm']],
    ['merge', 'before', ['checkout_part1.webm', 'checkout_part2.webm']],
    ['merge-then-transcode', 'after', ['checkout_run2.mp4']],
    ['merge-then-transcode', 'before', ['checkout.webm']],
  ] as const)(
    'never lists an earlier recording at the planned output when a %s throws %s publishing',
    async (kind, timing, expectedPaths) => {
      const scenario = await createCollisionScenario(kind, timing)

      await expect(scenario.coordinator.flush()).rejects.toBe(
        scenario.slotError,
      )
      await scenario.recorder.flush()

      const entry = (await aggregateManifestRun(scenario.context, 0)).runs[0]
        ?.entries[0]
      const segments = entry?.capture.segments ?? []
      expect(segments.map((segment) => segment.path)).toEqual(expectedPaths)
      for (const segment of segments) {
        await expect(
          fs.readFile(path.join(scenario.outputDir, segment.path), 'utf8'),
        ).resolves.not.toBe(EARLIER_RECORDING)
      }
      await expect(fs.readFile(scenario.earlierPath, 'utf8')).resolves.toBe(
        EARLIER_RECORDING,
      )
      expect(
        segments
          .flatMap(
            (segment) => segment.tabs ?? (segment.tab ? [segment.tab] : []),
          )
          .map((tab) => tab.reason),
      ).toEqual(scenario.tabReasons)
      expect(entry?.processing).toMatchObject({
        outcome: 'failed',
        operation: kind === 'merge' ? 'merge' : 'transcode',
        reason: 'deferred-processing-error',
      })
      expect(scenario.completeDeferred).toHaveBeenCalledOnce()
    },
  )

  it('fails an entry whose task threw and left no media', async () => {
    const { context, coordinator, harness, inputs, recorder } =
      await createMergeScenario(true)
    const crash = new Error('merge crashed')
    harness.merge.mockImplementation(async () => {
      await Promise.all(inputs.map(async (input) => fs.rm(input)))
      throw crash
    })

    await expect(coordinator.flush()).rejects.toBe(crash)
    await recorder.flush()

    const entry = (await aggregateManifestRun(context, 0)).runs[0]?.entries[0]
    expect(entry?.capture.segments).toEqual([])
    expect(entry?.capture.decision).toBe('failed')
  })

  it('queues one deferred merge, replaces segment tasks, and plans follow-up MP4 transcoding', async () => {
    const tempDir = await createTempDir()
    const segmentPaths = [
      path.join(tempDir, 'checkout_part2.webm'),
      path.join(tempDir, 'checkout_part1.webm'),
    ]
    const unrelatedTask = createTranscodeTask(
      path.join(tempDir, 'other.webm'),
      path.join(tempDir, 'other.mp4'),
    )
    const recorder = await createManifestRecorder(tempDir)
    await recorder.beginEntity({
      scope: 'test',
      specPaths: ['specs/checkout.ts'],
      test: { title: 'merges checkout' },
    })
    const harness = createHarness(
      {
        outputDir: tempDir,
        processing: {
          format: 'mp4',
          timing: 'after-worker',
          merge: { deleteSegments: true, enabled: true },
          transcode: {
            deleteOriginal: true,
            enabled: true,
            ffmpegArgs: ['-preset', 'slow'],
          },
        },
      },
      recorder,
    )
    harness.captureSession.beginRecording('checkout')
    for (const segmentPath of segmentPaths) {
      harness.captureSession.addRecordedPath(segmentPath)
      harness.coordinator.enqueue(
        createTranscodeTask(segmentPath, `${segmentPath}.mp4`),
      )
    }
    harness.coordinator.enqueue(unrelatedTask)

    await harness.coordinator.queueDeferredMerge()

    expect(harness.coordinator.pendingTasks).toEqual([
      unrelatedTask,
      {
        deleteSegments: true,
        kind: 'merge',
        manifestEntryId: recorder.currentEntryId,
        mergedPath: path.join(tempDir, 'checkout.webm'),
        segmentPaths: [
          path.join(tempDir, 'checkout_part1.webm'),
          path.join(tempDir, 'checkout_part2.webm'),
        ],
        transcodeToMp4: {
          deleteOriginal: true,
          ffmpegArgs: ['-preset', 'slow'],
          outputPath: path.join(tempDir, 'checkout.mp4'),
        },
      },
    ])
  })

  it('preserves immediate transcode input before applying an error failure policy', async () => {
    const tempDir = await createTempDir()
    const inputPath = path.join(tempDir, 'capture.webm')
    const outputPath = path.join(tempDir, 'capture.mp4')
    await fs.writeFile(inputPath, 'source-media', 'utf8')
    const harness = createHarness({
      failurePolicy: 'error',
      processing: {
        format: 'mp4',
        transcode: { enabled: true },
      },
    })
    harness.transcode.mockResolvedValue(undefined)
    harness.reportFailure.mockImplementation((message) => {
      expect(harness.captureSession.recordedPaths).toContain(inputPath)
      throw new Error(`[WdioPuppeteerVideoService] ${message}`)
    })

    await expect(
      harness.coordinator.finalizeSegment(
        createSegment(inputPath, outputPath, true),
      ),
    ).rejects.toThrow('keeping original recording')

    expect(harness.transcode).toHaveBeenCalledWith({
      deleteOriginal: true,
      inputPath,
      outputPath,
    })
    expect(harness.reportFailure).toHaveBeenCalledWith(
      `Transcode failed, keeping original recording: ${inputPath}`,
      true,
    )
    await expect(fs.readFile(inputPath, 'utf8')).resolves.toBe('source-media')
  })

  it('retains successful immediate output and passes custom transcode arguments', async () => {
    const tempDir = await createTempDir()
    const inputPath = path.join(tempDir, 'capture.webm')
    const requestedOutputPath = path.join(tempDir, 'capture.mp4')
    const publishedOutputPath = path.join(tempDir, 'capture_run2.mp4')
    await fs.writeFile(inputPath, 'source-media', 'utf8')
    const harness = createHarness({
      processing: {
        format: 'mp4',
        transcode: {
          enabled: true,
          ffmpegArgs: ['-preset', 'slow'],
        },
      },
    })
    harness.transcode.mockResolvedValue(publishedOutputPath)
    const segment = createSegment(inputPath, requestedOutputPath, true, [
      '-preset',
      'slow',
    ])

    await harness.coordinator.finalizeSegment(segment)

    expect(harness.transcode).toHaveBeenCalledWith({
      deleteOriginal: true,
      ffmpegArgs: ['-preset', 'slow'],
      inputPath,
      outputPath: requestedOutputPath,
    })
    expect(segment.outputPath).toBe(publishedOutputPath)
    expect(harness.captureSession.recordedPaths).toEqual([publishedOutputPath])
  })

  it('retains deferred source paths without per-segment tasks when merging is enabled', async () => {
    const tempDir = await createTempDir()
    const recordingPath = path.join(tempDir, 'capture_part1.webm')
    await fs.writeFile(recordingPath, 'captured-media', 'utf8')
    const harness = createHarness({
      processing: {
        format: 'mp4',
        timing: 'after-worker',
        merge: { enabled: true },
        transcode: { enabled: true },
      },
    })

    await harness.coordinator.finalizeSegment(
      createSegment(
        recordingPath,
        path.join(tempDir, 'capture_part1.mp4'),
        true,
      ),
    )

    expect(harness.captureSession.recordedPaths).toEqual([recordingPath])
    expect(harness.coordinator.pendingTasks).toEqual([])
  })

  it('keeps original segments when an immediate merge fails', async () => {
    const tempDir = await createTempDir()
    const segmentPaths = [
      path.join(tempDir, 'checkout_part1.webm'),
      path.join(tempDir, 'checkout_part2.webm'),
    ]
    const harness = createHarness({
      outputDir: tempDir,
      processing: { merge: { deleteSegments: true, enabled: true } },
    })
    harness.captureSession.beginRecording('checkout')
    for (const segmentPath of segmentPaths) {
      harness.captureSession.addRecordedPath(segmentPath)
    }
    harness.merge.mockResolvedValue(undefined)

    await harness.coordinator.mergeCurrentSegments()

    expect(harness.merge).toHaveBeenCalledWith({
      deleteSegments: true,
      ffmpegOperation: 'segment merge',
      mergedPath: path.join(tempDir, 'checkout.webm'),
      segmentPaths,
      writeFailureContext: 'merge',
    })
    expect(harness.captureSession.recordedPaths).toEqual(segmentPaths)
    expect(harness.reportFailure).toHaveBeenCalledWith(
      'Merge failed, keeping 2 original segment(s).',
    )
  })

  it('publishes a successful immediate merge and removes deleted segment paths', async () => {
    const tempDir = await createTempDir()
    const segmentPaths = [
      path.join(tempDir, 'checkout_part1.webm'),
      path.join(tempDir, 'checkout_part2.webm'),
    ]
    const mergedPath = path.join(tempDir, 'checkout.webm')
    const harness = createHarness({
      outputDir: tempDir,
      processing: { merge: { deleteSegments: true, enabled: true } },
    })
    harness.captureSession.beginRecording('checkout')
    for (const segmentPath of segmentPaths) {
      harness.captureSession.addRecordedPath(segmentPath)
    }
    harness.merge.mockImplementation(async () => {
      await fs.writeFile(mergedPath, 'merged-media', 'utf8')
      return mergedPath
    })

    await harness.coordinator.mergeCurrentSegments()

    expect(harness.captureSession.recordedPaths).toEqual([mergedPath])
    expect(harness.reportFailure).not.toHaveBeenCalled()
  })

  it('retains source paths when a successful immediate merge is configured not to delete them', async () => {
    const tempDir = await createTempDir()
    const segmentPath = path.join(tempDir, 'checkout_part1.webm')
    const mergedPath = path.join(tempDir, 'checkout.webm')
    const harness = createHarness({
      outputDir: tempDir,
      processing: { merge: { deleteSegments: false, enabled: true } },
    })
    harness.captureSession.beginRecording('checkout')
    harness.captureSession.addRecordedPath(segmentPath)
    harness.merge.mockResolvedValue(mergedPath)

    await harness.coordinator.mergeCurrentSegments()

    expect(harness.captureSession.recordedPaths).toEqual([
      segmentPath,
      mergedPath,
    ])
  })

  it('bounds deferred workers, drains all work, and rethrows the first queued failure', async () => {
    const tempDir = await createTempDir()
    const inputPaths = await createInputFiles(tempDir, [
      'first.webm',
      'second.webm',
      'third.webm',
    ])
    const firstGate = createDeferred<void>()
    const twoWorkersStarted = createDeferred<void>()
    const started: string[] = []
    let active = 0
    let maximumActive = 0
    const harness = createHarness({
      concurrency: { maxPostProcessesPerProcess: 2 },
      processing: { timing: 'after-worker' },
    })
    harness.transcode.mockImplementation(async ({ inputPath }) => {
      started.push(path.basename(inputPath))
      active += 1
      maximumActive = Math.max(maximumActive, active)
      if (started.length === 2) {
        twoWorkersStarted.resolve()
      }
      try {
        await twoWorkersStarted.promise
        if (inputPath === inputPaths[0]) {
          await firstGate.promise
          throw new Error('first deferred failure')
        }
        if (inputPath === inputPaths[1]) {
          throw new Error('second deferred failure')
        }
        return `${inputPath}.mp4`
      } finally {
        active -= 1
      }
    })
    for (const inputPath of inputPaths) {
      harness.coordinator.enqueue(
        createTranscodeTask(inputPath, `${inputPath}.mp4`),
      )
    }

    const flushing = harness.coordinator.flush()
    await vi.waitFor(() => {
      expect(started).toHaveLength(3)
    })
    expect([...started].sort()).toEqual([
      'first.webm',
      'second.webm',
      'third.webm',
    ])
    firstGate.resolve()

    await expect(flushing).rejects.toThrow('first deferred failure')
    expect(maximumActive).toBe(2)
    expect(harness.coordinator.pendingTaskCount).toBe(0)
    expect(harness.logs.filter(({ level }) => level === 'error')).toHaveLength(
      2,
    )
  })

  it('updates every manifest outcome while preserving failed deferred input', async () => {
    const tempDir = await createTempDir()
    const [failedInput, successfulInput] = await createInputFiles(tempDir, [
      'failed.webm',
      'successful.webm',
    ])
    if (!failedInput || !successfulInput) {
      throw new TypeError('Expected deferred input fixtures')
    }
    const successfulOutput = path.join(tempDir, 'successful.mp4')
    const recorder = await createManifestRecorder(tempDir)
    const completeDeferred = vi
      .spyOn(recorder, 'completeDeferred')
      .mockResolvedValue()
    const harness = createHarness(
      {
        concurrency: { maxPostProcessesPerProcess: 2 },
        failurePolicy: 'error',
        processing: { timing: 'after-worker' },
      },
      recorder,
    )
    harness.transcode.mockImplementation(async ({ inputPath }) =>
      inputPath === failedInput ? undefined : successfulOutput,
    )
    harness.reportFailure.mockImplementation((message) => {
      throw new Error(`[WdioPuppeteerVideoService] ${message}`)
    })
    harness.coordinator.enqueue({
      ...createTranscodeTask(failedInput, path.join(tempDir, 'failed.mp4')),
      manifestEntryId: 'failed-entry',
    })
    harness.coordinator.enqueue({
      ...createTranscodeTask(successfulInput, successfulOutput),
      manifestEntryId: 'successful-entry',
    })

    await expect(harness.coordinator.flush()).rejects.toThrow(
      `Deferred transcode failed, keeping original recording: ${failedInput}`,
    )

    expect(completeDeferred).toHaveBeenCalledTimes(2)
    expect(completeDeferred).toHaveBeenCalledWith('failed-entry', {
      decision: 'recorded',
      paths: [failedInput],
      processingOperation: 'transcode',
      processingOutcome: 'failed',
      reason: 'deferred-transcode-failed-original-preserved',
      replaces: [failedInput],
    })
    expect(completeDeferred).toHaveBeenCalledWith('successful-entry', {
      decision: 'recorded',
      paths: [successfulOutput],
      processingOperation: 'transcode',
      processingOutcome: 'completed',
      replaces: [successfulInput],
    })
    await expect(fs.readFile(failedInput, 'utf8')).resolves.toBe('failed.webm')
  })

  it('reports missing deferred input and dispatches existing input options', async () => {
    const tempDir = await createTempDir()
    const missingInput = path.join(tempDir, 'missing.webm')
    const existingInput = path.join(tempDir, 'existing.webm')
    const outputPath = path.join(tempDir, 'output.mp4')
    await fs.writeFile(existingInput, 'media', 'utf8')
    const recorder = await createManifestRecorder(tempDir)
    const completeDeferred = vi
      .spyOn(recorder, 'completeDeferred')
      .mockResolvedValue()
    const harness = createHarness({}, recorder)
    harness.transcode.mockResolvedValue(outputPath)

    await harness.coordinator.executeTranscode({
      deleteOriginal: true,
      inputPath: missingInput,
      kind: 'transcode',
      manifestEntryId: 'missing-entry',
      outputPath,
    })

    expect(harness.transcode).not.toHaveBeenCalled()
    expect(harness.reportFailure).toHaveBeenCalledWith(
      `Deferred transcode input is missing: ${missingInput}`,
    )
    expect(completeDeferred).toHaveBeenCalledWith('missing-entry', {
      decision: 'failed',
      paths: [missingInput],
      processingOperation: 'transcode',
      processingOutcome: 'failed',
      reason: 'deferred-transcode-input-missing',
      replaces: [missingInput],
    })

    await harness.coordinator.executeTranscode({
      deleteOriginal: false,
      ffmpegArgs: ['-preset', 'slow'],
      inputPath: existingInput,
      kind: 'transcode',
      outputPath,
    })

    expect(harness.transcode).toHaveBeenCalledWith({
      deleteOriginal: false,
      ffmpegArgs: ['-preset', 'slow'],
      inputPath: existingInput,
      onPublished: expect.any(Function),
      outputPath,
    })
  })

  it('chains a successful deferred merge into MP4 transcoding', async () => {
    const tempDir = await createTempDir()
    const segmentPaths = [
      path.join(tempDir, 'capture_part1.webm'),
      path.join(tempDir, 'capture_part2.webm'),
    ]
    const mergedPath = path.join(tempDir, 'capture.webm')
    const outputPath = path.join(tempDir, 'capture.mp4')
    const recorder = await createManifestRecorder(tempDir)
    const completeDeferred = vi
      .spyOn(recorder, 'completeDeferred')
      .mockResolvedValue()
    const harness = createHarness({}, recorder)
    harness.merge.mockImplementation(async () => {
      await fs.writeFile(mergedPath, 'merged-media', 'utf8')
      return mergedPath
    })
    harness.transcode.mockResolvedValue(outputPath)

    await harness.coordinator.executeMerge({
      deleteSegments: true,
      kind: 'merge',
      manifestEntryId: 'merge-entry',
      mergedPath,
      segmentPaths,
      transcodeToMp4: {
        deleteOriginal: true,
        ffmpegArgs: ['-preset', 'slow'],
        outputPath,
      },
    })

    expect(harness.merge).toHaveBeenCalledWith({
      deleteSegments: true,
      ffmpegOperation: 'deferred segment merge',
      mergedPath,
      onPublished: expect.any(Function),
      segmentPaths,
      writeFailureContext: 'deferred merge',
    })
    expect(harness.transcode).toHaveBeenCalledWith({
      deleteOriginal: true,
      ffmpegArgs: ['-preset', 'slow'],
      inputPath: mergedPath,
      onPublished: expect.any(Function),
      outputPath,
    })
    expect(completeDeferred).toHaveBeenCalledOnce()
    expect(completeDeferred).toHaveBeenCalledWith('merge-entry', {
      decision: 'recorded',
      paths: [outputPath],
      processingOperation: 'transcode',
      processingOutcome: 'completed',
    })
  })

  it('records terminal deferred merge success and failure outcomes', async () => {
    const tempDir = await createTempDir()
    const recorder = await createManifestRecorder(tempDir)
    const completeDeferred = vi
      .spyOn(recorder, 'completeDeferred')
      .mockResolvedValue()
    const harness = createHarness({}, recorder)
    const successfulTask = {
      deleteSegments: true,
      kind: 'merge' as const,
      manifestEntryId: 'successful-merge',
      mergedPath: path.join(tempDir, 'successful.webm'),
      segmentPaths: [path.join(tempDir, 'successful_part1.webm')],
    }
    harness.merge.mockResolvedValueOnce(successfulTask.mergedPath)

    await harness.coordinator.executeMerge(successfulTask)

    expect(completeDeferred).toHaveBeenCalledWith('successful-merge', {
      decision: 'recorded',
      paths: [successfulTask.mergedPath],
      processingOperation: 'merge',
      processingOutcome: 'completed',
    })

    const failedTask = {
      deleteSegments: true,
      kind: 'merge' as const,
      manifestEntryId: 'failed-merge',
      mergedPath: path.join(tempDir, 'failed.webm'),
      segmentPaths: [
        path.join(tempDir, 'failed_part1.webm'),
        path.join(tempDir, 'failed_part2.webm'),
      ],
    }
    harness.merge.mockResolvedValueOnce(undefined)

    await harness.coordinator.executeMerge(failedTask)

    expect(completeDeferred).toHaveBeenCalledWith('failed-merge', {
      decision: 'recorded',
      paths: failedTask.segmentPaths,
      processingOperation: 'merge',
      processingOutcome: 'failed',
      reason: 'deferred-merge-failed-segments-preserved',
    })
    expect(harness.reportFailure).toHaveBeenCalledWith(
      'Deferred merge failed, keeping 2 original segment(s).',
    )
  })

  it('flushes queued merge work and treats manifest recording as optional', async () => {
    const tempDir = await createTempDir()
    const mergedPath = path.join(tempDir, 'capture.webm')
    const harness = createHarness({
      concurrency: { maxPostProcessesPerProcess: 1 },
      processing: { timing: 'after-worker' },
    })
    harness.merge.mockResolvedValue(mergedPath)
    harness.coordinator.enqueue({
      deleteSegments: false,
      kind: 'merge',
      mergedPath,
      segmentPaths: [path.join(tempDir, 'capture_part1.webm')],
    })

    await harness.coordinator.flush()

    expect(harness.merge).toHaveBeenCalledOnce()
    expect(harness.coordinator.hasPendingTasks).toBe(false)
    expect(harness.logs.some(({ level }) => level === 'info')).toBe(true)
  })

  it('handles failed deferred work without an active manifest recorder', async () => {
    const tempDir = await createTempDir()
    const existingInput = path.join(tempDir, 'existing.webm')
    await fs.writeFile(existingInput, 'media', 'utf8')
    const harness = createHarness()
    harness.transcode.mockResolvedValue(undefined)
    harness.merge.mockResolvedValue(undefined)

    await harness.coordinator.executeTranscode({
      deleteOriginal: true,
      inputPath: path.join(tempDir, 'missing.webm'),
      kind: 'transcode',
      outputPath: path.join(tempDir, 'missing.mp4'),
    })
    await harness.coordinator.executeTranscode(
      createTranscodeTask(existingInput, path.join(tempDir, 'existing.mp4')),
    )
    await harness.coordinator.executeMerge({
      deleteSegments: true,
      kind: 'merge',
      mergedPath: path.join(tempDir, 'merged.webm'),
      segmentPaths: [path.join(tempDir, 'part1.webm')],
    })

    expect(harness.reportFailure).toHaveBeenCalledTimes(3)
  })

  it('drops queued work touching blocked inputs, outputs, segments, or follow-up outputs', () => {
    const harness = createHarness()
    const keepTask = createTranscodeTask('keep-input.webm', 'keep-output.mp4')
    const tasks: DeferredPostProcessTask[] = [
      keepTask,
      createTranscodeTask('blocked-input.webm', 'other-output.mp4'),
      createTranscodeTask('other-input.webm', 'blocked-output.mp4'),
      {
        deleteSegments: true,
        kind: 'merge',
        mergedPath: 'blocked-merged.webm',
        segmentPaths: ['part1.webm'],
      },
      {
        deleteSegments: true,
        kind: 'merge',
        mergedPath: 'merged.webm',
        segmentPaths: ['blocked-segment.webm'],
      },
      {
        deleteSegments: true,
        kind: 'merge',
        mergedPath: 'transcoded.webm',
        segmentPaths: ['part2.webm'],
        transcodeToMp4: {
          deleteOriginal: true,
          outputPath: 'blocked-follow-up.mp4',
        },
      },
    ]
    for (const task of tasks) {
      harness.coordinator.enqueue(task)
    }

    harness.coordinator.dropTasksForPaths([
      'blocked-input.webm',
      'blocked-output.mp4',
      'blocked-merged.webm',
      'blocked-segment.webm',
      'blocked-follow-up.mp4',
    ])

    expect(harness.coordinator.pendingTasks).toEqual([keepTask])
    harness.coordinator.dropTasksForPaths([])
    expect(harness.coordinator.pendingTasks).toEqual([keepTask])
  })

  it('deletes retained segments, tolerates missing files, drops their work, and clears session state', async () => {
    const tempDir = await createTempDir()
    const existingPath = path.join(tempDir, 'existing.webm')
    const missingPath = path.join(tempDir, 'missing.webm')
    const unrelatedPath = path.join(tempDir, 'unrelated.webm')
    await Promise.all([
      fs.writeFile(existingPath, 'existing', 'utf8'),
      fs.writeFile(unrelatedPath, 'unrelated', 'utf8'),
    ])
    const harness = createHarness()
    harness.captureSession.beginRecording('cleanup')
    harness.captureSession.addRecordedPath(existingPath)
    harness.captureSession.addRecordedPath(missingPath)
    harness.coordinator.enqueue(
      createTranscodeTask(existingPath, `${existingPath}.mp4`),
    )
    const unrelatedTask = createTranscodeTask(
      unrelatedPath,
      `${unrelatedPath}.mp4`,
    )
    harness.coordinator.enqueue(unrelatedTask)

    await harness.coordinator.deleteRecordedSegments()

    await expect(fs.stat(existingPath)).rejects.toThrow()
    await expect(fs.readFile(unrelatedPath, 'utf8')).resolves.toBe('unrelated')
    expect(harness.captureSession.recordedPaths).toEqual([])
    expect(harness.coordinator.pendingTasks).toEqual([unrelatedTask])
  })

  it('removes empty captures, reports missing captures, and retains output directly', async () => {
    const tempDir = await createTempDir()
    const emptyPath = path.join(tempDir, 'empty.webm')
    const capturedPath = path.join(tempDir, 'captured.webm')
    await Promise.all([
      fs.writeFile(emptyPath, ''),
      fs.writeFile(capturedPath, 'media', 'utf8'),
    ])
    const harness = createHarness()

    await harness.coordinator.finalizeSegment(
      createSegment(emptyPath, emptyPath, false),
    )
    await expect(
      harness.coordinator.finalizeSegment(
        createSegment(
          path.join(tempDir, 'already-removed.webm'),
          path.join(tempDir, 'already-removed.webm'),
          false,
        ),
      ),
    ).resolves.toBeUndefined()
    await harness.coordinator.finalizeSegment(
      createSegment(capturedPath, capturedPath, false),
    )

    await expect(fs.stat(emptyPath)).rejects.toThrow()
    expect(harness.captureSession.recordedPaths).toEqual([capturedPath])
    expect(
      harness.logs.some(({ message }) => message.includes('file is empty')),
    ).toBe(true)
    expect(harness.reportFailure).toHaveBeenCalledWith(
      expect.stringContaining('Recording file is missing'),
    )
  })

  it('applies the error failure policy when a recording file is missing', async () => {
    const tempDir = await createTempDir()
    const missingPath = path.join(tempDir, 'missing.webm')
    const harness = createHarness({ failurePolicy: 'error' })
    harness.reportFailure.mockImplementation((message) => {
      throw new Error(`[WdioPuppeteerVideoService] ${message}`)
    })

    await expect(
      harness.coordinator.finalizeSegment(
        createSegment(missingPath, missingPath, false),
      ),
    ).rejects.toThrow('Recording file is missing')
  })

  it('preserves a capture when its file metadata cannot be inspected', async () => {
    const tempDir = await createTempDir()
    const recordingPath = path.join(tempDir, 'preserved.webm')
    await fs.writeFile(recordingPath, 'valid-media', 'utf8')
    const statError = Object.assign(new Error('temporary I/O failure'), {
      code: 'EIO',
    })
    vi.spyOn(nodeFileSystem, 'stat').mockRejectedValueOnce(statError)
    const harness = createHarness()

    await harness.coordinator.finalizeSegment(
      createSegment(recordingPath, recordingPath, false),
    )

    await expect(fs.readFile(recordingPath, 'utf8')).resolves.toBe(
      'valid-media',
    )
    expect(harness.captureSession.recordedPaths).toEqual([recordingPath])
    expect(harness.reportFailure).toHaveBeenCalledWith(
      expect.stringContaining('temporary I/O failure'),
    )
  })

  it('safely skips merge planning without a compatible current segment set', async () => {
    const tempDir = await createTempDir()
    const harness = createHarness({ outputDir: tempDir })

    await harness.coordinator.queueDeferredMerge()
    await harness.coordinator.mergeCurrentSegments()
    harness.captureSession.beginRecording('capture')
    await harness.coordinator.queueDeferredMerge()
    await harness.coordinator.mergeCurrentSegments()
    harness.captureSession.addRecordedPath(
      path.join(tempDir, 'capture_part1.unknown'),
    )
    await harness.coordinator.queueDeferredMerge()
    harness.captureSession.addRecordedPath(
      path.join(tempDir, 'capture_part2.webm'),
    )
    await harness.coordinator.mergeCurrentSegments()
    await harness.coordinator.flush()

    expect(harness.merge).not.toHaveBeenCalled()
    expect(harness.coordinator.hasPendingTasks).toBe(false)
    expect(harness.logs.filter(({ level }) => level === 'warn')).toHaveLength(2)
  })
})

const createHarness = (
  serviceOptions: WdioPuppeteerVideoServiceOptions = {},
  manifestRecorder?: ManifestWorkerRecorder,
): CoordinatorHarness => {
  const captureSession = new CaptureSession()
  const logs: CoordinatorHarness['logs'] = []
  const merge = vi.fn<MediaPipeline['merge']>(async () => undefined)
  const reportFailure = vi.fn<MediaPipeline['reportFailure']>(() => undefined)
  const transcode = vi.fn<MediaPipeline['transcode']>(async () => undefined)
  const coordinatorOptions: RecordingMediaCoordinatorOptions = {
    captureSession,
    ffmpegRuntime: { shouldTranscode: () => true },
    fileSystem: nodeFileSystem,
    getManifestRecorder: () => manifestRecorder,
    log: (level, message, details) => {
      logs.push({
        level,
        message,
        ...(details === undefined ? {} : { details }),
      })
    },
    mediaPipeline: { merge, reportFailure, transcode },
    options: resolveServiceConfiguration(serviceOptions).options,
  }

  return {
    captureSession,
    coordinator: new RecordingMediaCoordinator(coordinatorOptions),
    logs,
    merge,
    reportFailure,
    transcode,
  }
}

const fileExists = async (filePath: string): Promise<boolean> =>
  fs.stat(filePath).then(
    () => true,
    () => false,
  )

/** A two-tab recording queued for an after-worker merge and MP4 transcode. */
const createMergeScenario = async (deleteSegments: boolean) => {
  const tempDir = await createTempDir()
  const context = await createManifestRunContext(tempDir)
  const recorder = new ManifestWorkerRecorder({
    cid: '0-0',
    context,
    framework: 'mocha',
  })
  await recorder.beginEntity({
    scope: 'test',
    specPaths: ['specs/tabs.ts'],
    test: { title: 'uses two tabs' },
  })
  const inputs = await createInputFiles(tempDir, [
    'tabs_part1.webm',
    'tabs_part2.webm',
  ])
  const mergedPath = path.join(tempDir, 'tabs.webm')
  const manifestEntryId = await recorder.completeCurrent({
    decision: 'recorded',
    result: 'passed',
    paths: inputs,
    processingOutcome: 'pending',
    processingOperation: 'merge',
    tabs: new Map([
      [1, { ordinal: 1, contextId: 'tab-a', reason: 'start' }],
      [2, { ordinal: 2, contextId: 'tab-b', reason: 'command' }],
    ]),
  })
  const harness = createHarness(
    {
      outputDir: tempDir,
      processing: {
        format: 'mp4',
        timing: 'after-worker',
        merge: { deleteSegments, enabled: true },
        transcode: { enabled: true },
      },
    },
    recorder,
  )
  harness.merge.mockImplementation(async () => {
    await fs.writeFile(mergedPath, 'merged', 'utf8')
    if (deleteSegments) {
      await Promise.all(inputs.map(async (input) => fs.rm(input)))
    }
    return mergedPath
  })
  harness.coordinator.enqueue({
    kind: 'merge',
    deleteSegments,
    mergedPath,
    segmentPaths: inputs,
    transcodeToMp4: {
      deleteOriginal: false,
      outputPath: path.join(tempDir, 'tabs.mp4'),
    },
    ...(manifestEntryId ? { manifestEntryId } : {}),
  })
  return {
    context,
    coordinator: harness.coordinator,
    harness,
    inputs,
    mergedPath,
    recorder,
  }
}

const EARLIER_RECORDING = 'earlier recording'

/**
 * A deferred task, run through the real pipeline and atomic publication, whose
 * planned output already holds another recording. The post-processing slot
 * throws before or after the task publishes.
 */
const createCollisionScenario = async (
  kind: 'merge' | 'merge-then-transcode' | 'transcode',
  timing: 'after' | 'before',
) => {
  const outputDir = await createTempDir()
  const context = await createManifestRunContext(outputDir)
  const recorder = new ManifestWorkerRecorder({
    cid: '0-0',
    context,
    framework: 'mocha',
  })
  await recorder.beginEntity({
    scope: 'test',
    specPaths: ['specs/checkout.ts'],
    test: { title: 'checks out' },
  })
  const inputs = await createInputFiles(
    outputDir,
    kind === 'transcode'
      ? ['checkout_part1.webm']
      : ['checkout_part1.webm', 'checkout_part2.webm'],
  )
  const tabReasons: readonly ('command' | 'start')[] =
    kind === 'transcode' ? ['start'] : ['start', 'command']
  const earlierPath = path.join(
    outputDir,
    {
      merge: 'checkout.webm',
      'merge-then-transcode': 'checkout.mp4',
      transcode: 'checkout_part1.mp4',
    }[kind],
  )
  await fs.writeFile(earlierPath, EARLIER_RECORDING, 'utf8')
  const manifestEntryId = await recorder.completeCurrent({
    decision: 'recorded',
    result: 'passed',
    paths: inputs,
    processingOutcome: 'pending',
    processingOperation: kind === 'transcode' ? 'transcode' : 'merge',
    tabs: new Map(
      tabReasons.map((reason, index) => [
        index + 1,
        { contextId: `tab-${index.toString()}`, ordinal: index + 1, reason },
      ]),
    ),
  })
  const slotError = new Error('post-processing slot failed')
  const failingOperation =
    kind === 'merge' ? 'deferred segment merge' : 'transcode'
  const mediaPipeline = new MediaPipeline({
    failurePolicy: 'warn',
    fileSystem: nodeFileSystem,
    log: () => undefined,
    outputDir,
    process: nodeProcess,
    runtime: {
      timestampPassthroughArgs: [],
      run: async (args, operation) => {
        const output = args.at(-1)
        if (output && !operation.endsWith('validation')) {
          await fs.writeFile(output, `${operation} output`, 'utf8')
        }
        return true
      },
      withPostProcessSlot: async (operation, task) => {
        if (operation !== failingOperation) {
          return task()
        }
        if (timing === 'after') {
          await task()
        }
        throw slotError
      },
    },
  })
  const coordinator = new RecordingMediaCoordinator({
    captureSession: new CaptureSession(),
    ffmpegRuntime: { shouldTranscode: () => true },
    fileSystem: nodeFileSystem,
    getManifestRecorder: () => recorder,
    log: () => undefined,
    mediaPipeline,
    options: resolveServiceConfiguration({ outputDir }).options,
  })
  const [firstInput] = inputs
  assert.ok(firstInput && manifestEntryId)
  coordinator.enqueue(
    kind === 'transcode'
      ? {
          kind: 'transcode',
          deleteOriginal: true,
          inputPath: firstInput,
          manifestEntryId,
          outputPath: earlierPath,
        }
      : {
          kind: 'merge',
          deleteSegments: true,
          manifestEntryId,
          mergedPath: path.join(outputDir, 'checkout.webm'),
          segmentPaths: inputs,
          ...(kind === 'merge-then-transcode'
            ? {
                transcodeToMp4: {
                  deleteOriginal: true,
                  outputPath: earlierPath,
                },
              }
            : {}),
        },
  )
  return {
    completeDeferred: vi.spyOn(recorder, 'completeDeferred'),
    context,
    coordinator,
    earlierPath,
    outputDir,
    recorder,
    slotError,
    tabReasons,
  }
}

const createTempDir = async (): Promise<string> => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wdio-video-media-coordinator-unit-'),
  )
  tempDirs.push(tempDir)
  return tempDir
}

const createManifestRecorder = async (
  outputDir: string,
): Promise<ManifestWorkerRecorder> => {
  return new ManifestWorkerRecorder({
    cid: '0-0',
    context: await createManifestRunContext(outputDir),
    framework: 'mocha',
  })
}

const createSegment = (
  recordingPath: string,
  outputPath: string,
  transcode: boolean,
  ffmpegArgs?: string[],
): ActiveSegment => ({
  onRecorderError: () => undefined,
  onWriteStreamError: () => undefined,
  outputFormat: transcode ? 'mp4' : 'webm',
  outputPath,
  recordingFormat: 'webm',
  recordingPath,
  transcode,
  transcodeOptions: {
    deleteOriginal: true,
    ...(ffmpegArgs === undefined ? {} : { ffmpegArgs }),
  },
  writeStream: undefined as never,
  writeStreamDone: Promise.resolve(),
  writeStreamErrored: false,
})

const createTranscodeTask = (
  inputPath: string,
  outputPath: string,
): DeferredTranscodeTask => ({
  deleteOriginal: true,
  inputPath,
  kind: 'transcode',
  outputPath,
})

const createInputFiles = async (
  outputDir: string,
  names: readonly string[],
): Promise<string[]> => {
  const inputPaths = names.map((name) => path.join(outputDir, name))
  await Promise.all(
    inputPaths.map((inputPath) =>
      fs.writeFile(inputPath, path.basename(inputPath), 'utf8'),
    ),
  )
  return inputPaths
}

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
