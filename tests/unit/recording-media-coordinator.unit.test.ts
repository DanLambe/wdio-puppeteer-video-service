import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nodeFileSystem } from '../../src/service/boundaries.js'
import { CaptureSession } from '../../src/service/capture-session.js'
import type {
  ActiveSegment,
  DeferredPostProcessTask,
  DeferredTranscodeTask,
} from '../../src/service/constants.js'
import {
  createManifestRunContext,
  ManifestWorkerRecorder,
} from '../../src/service/manifest-runtime.js'
import type { MediaPipeline } from '../../src/service/media-pipeline.js'
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
      try {
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
      expect(started).toEqual(['first.webm', 'second.webm', 'third.webm'])
    })
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
    })
    expect(completeDeferred).toHaveBeenCalledWith('successful-entry', {
      decision: 'recorded',
      paths: [successfulOutput],
      processingOperation: 'transcode',
      processingOutcome: 'completed',
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
      segmentPaths,
      writeFailureContext: 'deferred merge',
    })
    expect(harness.transcode).toHaveBeenCalledWith({
      deleteOriginal: true,
      ffmpegArgs: ['-preset', 'slow'],
      inputPath: mergedPath,
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

  it('removes empty captures and retains non-transcoded output directly', async () => {
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
