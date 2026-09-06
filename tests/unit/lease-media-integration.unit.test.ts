import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CaptureSession } from '../../src/service/capture-session.js'
import { createWorkerCompositionRoot } from '../../src/service/composition.js'
import { FfmpegRuntime } from '../../src/service/ffmpeg-runtime.js'
import {
  createManifestRunContext,
  ManifestWorkerRecorder,
} from '../../src/service/manifest-runtime.js'
import { MediaPipeline } from '../../src/service/media-pipeline.js'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import { RecordingMediaCoordinator } from '../../src/service/recording-media-coordinator.js'
import type { PostProcessSlotScheduler } from '../../src/service/recording-slots.js'

describe('lease acquisition failure through deferred media processing', () => {
  it.each(['warn', 'error'] as const)(
    'preserves input and completes the manifest before applying %s policy',
    async (failurePolicy) => {
      const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lease-media-'))
      try {
        const lockDir = path.join(outputDir, 'not-a-directory')
        const inputPath = path.join(outputDir, 'capture.webm')
        await fs.writeFile(lockDir, 'blocked lock directory')
        await fs.writeFile(inputPath, 'original captured bytes')
        const options = resolveServiceConfiguration({
          outputDir,
          failurePolicy,
          processing: { timing: 'after-worker', format: 'mp4' },
          concurrency: { lockDir, maxPostProcessesGlobal: 1 },
        }).options
        const log = vi.fn()
        const runFfmpeg = vi.fn(async () => true)
        const composition = createWorkerCompositionRoot({ runFfmpeg })
        const schedulers: PostProcessSlotScheduler[] = []
        const runtime = new FfmpegRuntime({
          options,
          log,
          process: composition.process,
          processRegistry: composition.createFfmpegProcessRegistry(),
          runFfmpeg,
          createPostProcessSlotScheduler: () => {
            const scheduler = composition.createPostProcessSlotScheduler(
              options,
              log,
              'test-run',
            )
            schedulers.push(scheduler)
            return scheduler
          },
        })
        const recorder = new ManifestWorkerRecorder({
          cid: '0-0',
          context: await createManifestRunContext(outputDir),
          framework: 'mocha',
        })
        const completeDeferred = vi
          .spyOn(recorder, 'completeDeferred')
          .mockResolvedValue()
        const coordinator = new RecordingMediaCoordinator({
          options,
          captureSession: new CaptureSession(),
          fileSystem: composition.fileSystem,
          ffmpegRuntime: runtime,
          getManifestRecorder: () => recorder,
          log,
          mediaPipeline: new MediaPipeline({
            failurePolicy,
            fileSystem: composition.fileSystem,
            log,
            outputDir,
            process: composition.process,
            runtime,
          }),
        })
        coordinator.enqueue({
          kind: 'transcode',
          inputPath,
          outputPath: path.join(outputDir, 'capture.mp4'),
          deleteOriginal: true,
          manifestEntryId: 'entry-1',
        })
        const flushing = coordinator.flush()
        if (failurePolicy === 'error') {
          await expect(flushing).rejects.toThrow('keeping original recording')
        } else {
          await expect(flushing).resolves.toBeUndefined()
        }
        expect(completeDeferred).toHaveBeenCalledExactlyOnceWith('entry-1', {
          decision: 'recorded',
          paths: [inputPath],
          reason: 'deferred-transcode-failed-original-preserved',
          processingOutcome: 'failed',
          processingOperation: 'transcode',
        })
        expect(coordinator.pendingTaskCount).toBe(0)
        expect(runFfmpeg).not.toHaveBeenCalled()
        expect(schedulers).toHaveLength(1)
        expect(schedulers[0]?.ownsPostProcessSlot).toBe(false)
        expect(schedulers[0]?.ownsGlobalPostProcessSlot).toBe(false)
        await expect(fs.readFile(inputPath, 'utf8')).resolves.toBe(
          'original captured bytes',
        )
        expect(log).toHaveBeenCalledWith(
          'warn',
          expect.stringContaining('Failed to acquire'),
          expect.any(Error),
        )
      } finally {
        await fs.rm(outputDir, { force: true, recursive: true })
      }
    },
  )
})
