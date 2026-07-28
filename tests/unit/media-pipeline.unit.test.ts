import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type FileSystemBoundary,
  nodeFileSystem,
  nodeProcess,
} from '../../src/service/boundaries.js'
import type { MergeExecutionOptions } from '../../src/service/constants.js'
import {
  MediaPipeline,
  type MediaPipelineRuntime,
} from '../../src/service/media-pipeline.js'
import type { FailurePolicy, LogLevel } from '../../src/types.js'

type RunHandler = (args: string[], operation: string) => Promise<boolean>

class FakeMediaRuntime implements MediaPipelineRuntime {
  readonly operations: Array<Readonly<{ args: string[]; operation: string }>> =
    []
  readonly slotOperations: string[] = []
  runHandler: RunHandler = async () => true
  slotAvailable = true

  async run(args: string[], operation: string): Promise<boolean> {
    this.operations.push({ args: [...args], operation })
    return this.runHandler(args, operation)
  }

  async withPostProcessSlot<T>(
    operation: string,
    task: () => Promise<T>,
  ): Promise<T | undefined> {
    this.slotOperations.push(operation)
    if (!this.slotAvailable) {
      return undefined
    }
    return task()
  }
}

interface PipelineHarness {
  readonly logEntries: Array<
    Readonly<{ details?: unknown; level: LogLevel; message: string }>
  >
  readonly pipeline: MediaPipeline
  readonly runtime: FakeMediaRuntime
}

describe('MediaPipeline', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((tempDir) =>
        fs.rm(tempDir, { recursive: true, force: true }).catch(() => {
          /* best-effort test cleanup */
        }),
      ),
    )
    tempDirs.length = 0
  })

  it('transcodes, validates, atomically publishes, and only then deletes the source', async () => {
    const tempDir = await createTempDir(tempDirs)
    const inputPath = path.join(tempDir, 'recording.webm')
    const outputPath = path.join(tempDir, 'recording.mp4')
    await fs.writeFile(inputPath, 'source-media', 'utf8')
    const harness = createHarness(tempDir)
    let temporaryPath: string | undefined

    harness.runtime.runHandler = async (args, operation) => {
      if (operation === 'transcode') {
        temporaryPath = args.at(-1)
        expect(temporaryPath).toBeDefined()
        expect(args).toEqual([
          '-n',
          '-i',
          inputPath,
          '-an',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-vf',
          'pad=ceil(iw/2)*2:ceil(ih/2)*2',
          '-preset',
          'slow',
          temporaryPath,
        ])
        await fs.writeFile(temporaryPath ?? '', 'verified-media', 'utf8')
        return true
      }

      expect(operation).toBe('transcode validation')
      expect(args).toEqual([
        '-v',
        'error',
        '-xerror',
        '-i',
        temporaryPath,
        '-map',
        '0:v:0',
        '-f',
        'null',
        '-',
      ])
      await expect(fs.readFile(inputPath, 'utf8')).resolves.toBe('source-media')
      await expect(fs.stat(outputPath)).rejects.toThrow()
      return true
    }

    await expect(
      harness.pipeline.transcode({
        deleteOriginal: true,
        ffmpegArgs: ['-preset', 'slow'],
        inputPath,
        outputPath,
      }),
    ).resolves.toBe(outputPath)

    expect(harness.runtime.slotOperations).toEqual(['transcode'])
    expect(
      harness.runtime.operations.map(({ operation }) => operation),
    ).toEqual(['transcode', 'transcode validation'])
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe(
      'verified-media',
    )
    await expect(fs.stat(inputPath)).rejects.toThrow()
    if (temporaryPath) {
      await expect(fs.stat(temporaryPath)).rejects.toThrow()
    }
  })

  it('keeps a verified publication when best-effort source deletion fails', async () => {
    const tempDir = await createTempDir(tempDirs)
    const inputPath = path.join(tempDir, 'recording.webm')
    const outputPath = path.join(tempDir, 'recording.mp4')
    await fs.writeFile(inputPath, 'source-media', 'utf8')
    const unlinkAttempts: string[] = []
    const fileSystem: FileSystemBoundary = {
      ...nodeFileSystem,
      async unlink(filePath): Promise<void> {
        unlinkAttempts.push(filePath)
        throw new Error('injected source cleanup failure')
      },
    }
    const harness = createHarness(tempDir, 'warn', fileSystem)

    harness.runtime.runHandler = async (args, operation) => {
      if (operation === 'transcode') {
        const temporaryPath = args.at(-1)
        expect(temporaryPath).toBeDefined()
        await fs.writeFile(temporaryPath ?? '', 'verified-media', 'utf8')
      }
      return true
    }

    await expect(
      harness.pipeline.transcode({
        deleteOriginal: true,
        inputPath,
        outputPath,
      }),
    ).resolves.toBe(outputPath)

    expect(unlinkAttempts).toEqual([inputPath])
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe(
      'verified-media',
    )
    await expect(fs.readFile(inputPath, 'utf8')).resolves.toBe('source-media')
  })

  it('preserves the source and removes partial output when transcode production fails', async () => {
    const tempDir = await createTempDir(tempDirs)
    const inputPath = path.join(tempDir, 'recording.webm')
    const outputPath = path.join(tempDir, 'recording.mp4')
    await fs.writeFile(inputPath, 'source-media', 'utf8')
    const harness = createHarness(tempDir)
    let temporaryPath: string | undefined

    harness.runtime.runHandler = async (args, operation) => {
      expect(operation).toBe('transcode')
      temporaryPath = args.at(-1)
      expect(temporaryPath).toBeDefined()
      await fs.writeFile(temporaryPath ?? '', 'partial-media', 'utf8')
      return false
    }

    await expect(
      harness.pipeline.transcode({
        deleteOriginal: true,
        inputPath,
        outputPath,
      }),
    ).resolves.toBeUndefined()

    expect(harness.runtime.operations).toHaveLength(1)
    await expect(fs.readFile(inputPath, 'utf8')).resolves.toBe('source-media')
    await expect(fs.stat(outputPath)).rejects.toThrow()
    if (temporaryPath) {
      await expect(fs.stat(temporaryPath)).rejects.toThrow()
    }
  })

  it('preserves the source and removes the candidate when validation fails', async () => {
    const tempDir = await createTempDir(tempDirs)
    const inputPath = path.join(tempDir, 'recording.webm')
    const outputPath = path.join(tempDir, 'recording.mp4')
    await fs.writeFile(inputPath, 'source-media', 'utf8')
    const harness = createHarness(tempDir)
    let temporaryPath: string | undefined

    harness.runtime.runHandler = async (args, operation) => {
      if (operation === 'transcode') {
        temporaryPath = args.at(-1)
        expect(temporaryPath).toBeDefined()
        await fs.writeFile(temporaryPath ?? '', 'corrupt-media', 'utf8')
        return true
      }
      expect(operation).toBe('transcode validation')
      return false
    }

    await expect(
      harness.pipeline.transcode({
        deleteOriginal: true,
        inputPath,
        outputPath,
      }),
    ).resolves.toBeUndefined()

    await expect(fs.readFile(inputPath, 'utf8')).resolves.toBe('source-media')
    await expect(fs.stat(outputPath)).rejects.toThrow()
    if (temporaryPath) {
      await expect(fs.stat(temporaryPath)).rejects.toThrow()
    }
    expect(
      harness.logEntries.some(({ message }) => message.includes('corrupt')),
    ).toBe(true)
  })

  it('publishes to a collision-safe path without overwriting an existing artifact', async () => {
    const tempDir = await createTempDir(tempDirs)
    const inputPath = path.join(tempDir, 'recording.webm')
    const outputPath = path.join(tempDir, 'recording.mp4')
    const collisionPath = path.join(tempDir, 'recording_run2.mp4')
    await Promise.all([
      fs.writeFile(inputPath, 'source-media', 'utf8'),
      fs.writeFile(outputPath, 'existing-media', 'utf8'),
    ])
    const harness = createHarness(tempDir)

    harness.runtime.runHandler = async (args, operation) => {
      if (operation === 'transcode') {
        const temporaryPath = args.at(-1)
        expect(temporaryPath).toBeDefined()
        await fs.writeFile(temporaryPath ?? '', 'new-media', 'utf8')
      }
      return true
    }

    await expect(
      harness.pipeline.transcode({
        deleteOriginal: false,
        inputPath,
        outputPath,
      }),
    ).resolves.toBe(collisionPath)

    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe(
      'existing-media',
    )
    await expect(fs.readFile(collisionPath, 'utf8')).resolves.toBe('new-media')
    await expect(fs.readFile(inputPath, 'utf8')).resolves.toBe('source-media')
  })

  it('merges and validates segments before deleting their sources', async () => {
    const tempDir = await createTempDir(tempDirs)
    const segmentPaths = [
      path.join(tempDir, 'recording_part1.webm'),
      path.join(tempDir, 'recording_part2.webm'),
    ]
    const mergedPath = path.join(tempDir, 'recording.webm')
    await Promise.all(
      segmentPaths.map((segmentPath, index) =>
        fs.writeFile(segmentPath, `segment-${(index + 1).toString()}`, 'utf8'),
      ),
    )
    const harness = createHarness(tempDir)

    harness.runtime.runHandler = async (args, operation) => {
      if (operation === 'segment merge') {
        const concatListPath = args[6]
        const temporaryPath = args.at(-1)
        expect(concatListPath).toBeDefined()
        expect(temporaryPath).toBeDefined()
        const concatList = await fs.readFile(concatListPath ?? '', 'utf8')
        expect(concatList).toContain(segmentPaths[0]?.replaceAll('\\', '/'))
        expect(concatList).toContain(segmentPaths[1]?.replaceAll('\\', '/'))
        await fs.writeFile(temporaryPath ?? '', 'merged-media', 'utf8')
        return true
      }

      expect(operation).toBe('segment merge validation')
      await Promise.all(
        segmentPaths.map((segmentPath) =>
          expect(fs.stat(segmentPath)).resolves.toBeDefined(),
        ),
      )
      return true
    }

    await expect(
      harness.pipeline.merge(
        createMergeRequest(segmentPaths, mergedPath, true),
      ),
    ).resolves.toBe(mergedPath)

    await expect(fs.readFile(mergedPath, 'utf8')).resolves.toBe('merged-media')
    await Promise.all(
      segmentPaths.map((segmentPath) =>
        expect(fs.stat(segmentPath)).rejects.toThrow(),
      ),
    )
    await expect(fs.readdir(tempDir)).resolves.not.toContainEqual(
      expect.stringContaining('_concat_'),
    )
  })

  it('preserves merge sources and removes partial output when ffmpeg fails', async () => {
    const tempDir = await createTempDir(tempDirs)
    const segmentPaths = [
      path.join(tempDir, 'recording_part1.webm'),
      path.join(tempDir, 'recording_part2.webm'),
    ]
    const mergedPath = path.join(tempDir, 'recording.webm')
    await Promise.all(
      segmentPaths.map((segmentPath) =>
        fs.writeFile(segmentPath, 'segment-media', 'utf8'),
      ),
    )
    const harness = createHarness(tempDir)
    let temporaryPath: string | undefined

    harness.runtime.runHandler = async (args, operation) => {
      expect(operation).toBe('segment merge')
      temporaryPath = args.at(-1)
      expect(temporaryPath).toBeDefined()
      await fs.writeFile(temporaryPath ?? '', 'partial-media', 'utf8')
      return false
    }

    await expect(
      harness.pipeline.merge(
        createMergeRequest(segmentPaths, mergedPath, true),
      ),
    ).resolves.toBeUndefined()

    await Promise.all(
      segmentPaths.map((segmentPath) =>
        expect(fs.readFile(segmentPath, 'utf8')).resolves.toBe('segment-media'),
      ),
    )
    await expect(fs.stat(mergedPath)).rejects.toThrow()
    if (temporaryPath) {
      await expect(fs.stat(temporaryPath)).rejects.toThrow()
    }
    await expect(fs.readdir(tempDir)).resolves.not.toContainEqual(
      expect.stringContaining('_concat_'),
    )
  })

  it('rejects an invalid merged artifact while preserving every source segment', async () => {
    const tempDir = await createTempDir(tempDirs)
    const segmentPaths = [
      path.join(tempDir, 'recording_part1.webm'),
      path.join(tempDir, 'recording_part2.webm'),
    ]
    const mergedPath = path.join(tempDir, 'recording.webm')
    await Promise.all(
      segmentPaths.map((segmentPath) =>
        fs.writeFile(segmentPath, 'segment-media', 'utf8'),
      ),
    )
    const harness = createHarness(tempDir)
    let temporaryPath: string | undefined

    harness.runtime.runHandler = async (args, operation) => {
      if (operation === 'segment merge') {
        temporaryPath = args.at(-1)
        expect(temporaryPath).toBeDefined()
        await fs.writeFile(temporaryPath ?? '', 'invalid-merged-media', 'utf8')
        return true
      }
      expect(operation).toBe('segment merge validation')
      return false
    }

    await expect(
      harness.pipeline.merge(
        createMergeRequest(segmentPaths, mergedPath, true),
      ),
    ).resolves.toBeUndefined()

    expect(
      harness.runtime.operations.map(({ operation }) => operation),
    ).toEqual(['segment merge', 'segment merge validation'])
    expect(
      harness.logEntries.some(({ message }) => message.includes('corrupt')),
    ).toBe(true)
    await Promise.all(
      segmentPaths.map((segmentPath) =>
        expect(fs.readFile(segmentPath, 'utf8')).resolves.toBe('segment-media'),
      ),
    )
    await expect(fs.stat(mergedPath)).rejects.toThrow()
    if (temporaryPath) {
      await expect(fs.stat(temporaryPath)).rejects.toThrow()
    }
    await expect(fs.readdir(tempDir)).resolves.not.toContainEqual(
      expect.stringContaining('_concat_'),
    )
  })

  it('does not start ffmpeg or modify sources when a post-process slot is unavailable', async () => {
    const tempDir = await createTempDir(tempDirs)
    const inputPath = path.join(tempDir, 'recording.webm')
    const outputPath = path.join(tempDir, 'recording.mp4')
    const segmentPath = path.join(tempDir, 'recording_part1.webm')
    const mergedPath = path.join(tempDir, 'merged.webm')
    await Promise.all([
      fs.writeFile(inputPath, 'transcode-source', 'utf8'),
      fs.writeFile(segmentPath, 'merge-source', 'utf8'),
    ])
    const harness = createHarness(tempDir)
    harness.runtime.slotAvailable = false

    await expect(
      harness.pipeline.transcode({
        deleteOriginal: true,
        inputPath,
        outputPath,
      }),
    ).resolves.toBeUndefined()
    await expect(
      harness.pipeline.merge(
        createMergeRequest([segmentPath], mergedPath, true),
      ),
    ).resolves.toBeUndefined()

    expect(harness.runtime.slotOperations).toEqual([
      'transcode',
      'segment merge',
    ])
    expect(harness.runtime.operations).toHaveLength(0)
    await expect(fs.readFile(inputPath, 'utf8')).resolves.toBe(
      'transcode-source',
    )
    await expect(fs.readFile(segmentPath, 'utf8')).resolves.toBe('merge-source')
    await expect(fs.stat(outputPath)).rejects.toThrow()
    await expect(fs.stat(mergedPath)).rejects.toThrow()
  })

  it('warns for warn policy and throws for error policy without duplicate logging', async () => {
    const tempDir = await createTempDir(tempDirs)
    const warningHarness = createHarness(tempDir, 'warn')

    expect(() =>
      warningHarness.pipeline.reportFailure('merge failed'),
    ).not.toThrow()
    expect(warningHarness.logEntries).toEqual([
      {
        level: 'warn',
        message: '[WdioPuppeteerVideoService] merge failed',
      },
    ])
    warningHarness.pipeline.reportFailure('already logged', true)
    expect(warningHarness.logEntries).toHaveLength(1)

    const errorHarness = createHarness(tempDir, 'error')
    expect(() =>
      errorHarness.pipeline.reportFailure('transcode failed'),
    ).toThrow('[WdioPuppeteerVideoService] transcode failed')
    expect(errorHarness.logEntries).toEqual([
      {
        level: 'warn',
        message: '[WdioPuppeteerVideoService] transcode failed',
      },
    ])
    expect(() =>
      errorHarness.pipeline.reportFailure('already logged', true),
    ).toThrow('[WdioPuppeteerVideoService] already logged')
    expect(errorHarness.logEntries).toHaveLength(1)
  })
})

const createHarness = (
  outputDir: string,
  failurePolicy: FailurePolicy = 'warn',
  fileSystem: FileSystemBoundary = nodeFileSystem,
): PipelineHarness => {
  const runtime = new FakeMediaRuntime()
  const logEntries: PipelineHarness['logEntries'] = []
  const pipeline = new MediaPipeline({
    failurePolicy,
    fileSystem,
    log: (level, message, details) => {
      logEntries.push({
        level,
        message,
        ...(details === undefined ? {} : { details }),
      })
    },
    outputDir,
    process: nodeProcess,
    runtime,
  })
  return { logEntries, pipeline, runtime }
}

const createMergeRequest = (
  segmentPaths: string[],
  mergedPath: string,
  deleteSegments: boolean,
): MergeExecutionOptions => {
  return {
    deleteSegments,
    ffmpegOperation: 'segment merge',
    mergedPath,
    segmentPaths,
    writeFailureContext: 'segment merge',
  }
}

const createTempDir = async (tempDirs: string[]): Promise<string> => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wdio-video-media-pipeline-unit-'),
  )
  tempDirs.push(tempDir)
  return tempDir
}
