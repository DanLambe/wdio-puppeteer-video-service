import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedTranscodeOptions } from '../../src/service/constants.js'
import {
  buildConcatMergeArgs,
  buildH264TranscodeArgs,
  createDeferredMergeTask,
  createDeferredTranscodeTask,
  mergeSegmentPathsToOutput,
} from '../../src/service/post-process.js'

describe('post-process helpers', () => {
  const tempDirs: string[] = []
  const transcodeOptions: ResolvedTranscodeOptions = {
    deleteOriginal: true,
    ffmpegArgs: ['-preset', 'slow'],
  }

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((tempDir) =>
        fs.rm(tempDir, { recursive: true, force: true }).catch(() => {
          /* best-effort cleanup */
        }),
      ),
    )
    tempDirs.length = 0
  })

  it('creates deferred transcode tasks with optional ffmpeg args', () => {
    expect(
      createDeferredTranscodeTask(
        'segment_part1.webm',
        'segment_part1.mp4',
        transcodeOptions,
      ),
    ).toEqual({
      kind: 'transcode',
      inputPath: 'segment_part1.webm',
      outputPath: 'segment_part1.mp4',
      deleteOriginal: true,
      ffmpegArgs: ['-preset', 'slow'],
    })
  })

  it('creates deferred merge tasks that transcode merged webm output to mp4', () => {
    const task = createDeferredMergeTask({
      deleteSegments: true,
      getMergedOutputPath: (format) => `merged.${format}`,
      mergedFormat: 'webm',
      outputFormat: 'mp4',
      segmentPaths: ['part1.webm', 'part2.webm'],
      shouldTranscodeMergedOutput: true,
      transcodeOptions,
    })

    expect(task).toEqual({
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
  })

  it('creates deferred merge tasks without transcode when merge output is final', () => {
    const task = createDeferredMergeTask({
      deleteSegments: false,
      getMergedOutputPath: (format) => `merged.${format}`,
      mergedFormat: 'mp4',
      outputFormat: 'mp4',
      segmentPaths: ['part1.mp4'],
      shouldTranscodeMergedOutput: false,
      transcodeOptions: {
        deleteOriginal: false,
      },
    })

    expect(task).toEqual({
      kind: 'merge',
      segmentPaths: ['part1.mp4'],
      mergedPath: 'merged.mp4',
      deleteSegments: false,
    })
  })

  it('builds H.264 transcode args with custom ffmpeg args before the output path', () => {
    expect(
      buildH264TranscodeArgs('input.webm', 'output.mp4', ['-preset', 'slow']),
    ).toEqual([
      '-y',
      '-i',
      'input.webm',
      '-an',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      '-preset',
      'slow',
      'output.mp4',
    ])
  })

  it('builds concat merge args with the concat list ahead of the output path', () => {
    expect(
      buildConcatMergeArgs('merge_concat.txt', 'merged_output.webm'),
    ).toEqual([
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      'merge_concat.txt',
      '-c',
      'copy',
      'merged_output.webm',
    ])
  })

  it('copies a single segment when deleteSegments is disabled', async () => {
    const tempDir = await createTempDir(tempDirs)
    const segmentPath = path.join(tempDir, 'part1.webm')
    const mergedPath = path.join(tempDir, 'merged.webm')

    await fs.writeFile(segmentPath, 'segment-data', 'utf8')

    await expect(
      mergeSegmentPathsToOutput({
        deleteSegments: false,
        ffmpegOperation: 'segment merge',
        mergedPath,
        outputDir: tempDir,
        runFfmpeg: async () => true,
        segmentPaths: [segmentPath],
        warn: vi.fn(),
        writeFailureContext: 'segment merge',
      }),
    ).resolves.toBe(true)

    await expect(fs.readFile(mergedPath, 'utf8')).resolves.toBe('segment-data')
    await expect(fs.readFile(segmentPath, 'utf8')).resolves.toBe('segment-data')
  })

  it('moves a single segment when deleteSegments is enabled', async () => {
    const tempDir = await createTempDir(tempDirs)
    const segmentPath = path.join(tempDir, 'part1.webm')
    const mergedPath = path.join(tempDir, 'merged.webm')

    await fs.writeFile(segmentPath, 'segment-data', 'utf8')

    await expect(
      mergeSegmentPathsToOutput({
        deleteSegments: true,
        ffmpegOperation: 'segment merge',
        mergedPath,
        outputDir: tempDir,
        runFfmpeg: async () => true,
        segmentPaths: [segmentPath],
        warn: vi.fn(),
        writeFailureContext: 'segment merge',
      }),
    ).resolves.toBe(true)

    await expect(fs.readFile(mergedPath, 'utf8')).resolves.toBe('segment-data')
    await expect(fs.stat(segmentPath)).rejects.toThrow()
  })

  it('merges multiple segments via ffmpeg and cleans up concat input files', async () => {
    const tempDir = await createTempDir(tempDirs)
    const mergedPath = path.join(tempDir, 'merged.webm')
    const segmentPaths = [
      path.join(tempDir, 'part1.webm'),
      path.join(tempDir, 'part2.webm'),
    ]
    const writtenConcatLists: string[] = []
    await Promise.all(
      segmentPaths.map((segmentPath, index) =>
        fs.writeFile(segmentPath, `segment-${index + 1}`, 'utf8'),
      ),
    )

    const runFfmpeg = vi.fn(async (args: string[], operation: string) => {
      expect(operation).toBe('segment merge')

      const concatListPath = args[6]
      expect(concatListPath).toBeDefined()
      if (!concatListPath) {
        return false
      }

      writtenConcatLists.push(concatListPath)
      await expect(fs.readFile(concatListPath, 'utf8')).resolves.toContain(
        "file '",
      )
      await fs.writeFile(mergedPath, 'merged-data', 'utf8')

      expect(args).toEqual(buildConcatMergeArgs(concatListPath, mergedPath))
      return true
    })

    await expect(
      mergeSegmentPathsToOutput({
        deleteSegments: true,
        ffmpegOperation: 'segment merge',
        mergedPath,
        outputDir: tempDir,
        runFfmpeg,
        segmentPaths,
        warn: vi.fn(),
        writeFailureContext: 'segment merge',
      }),
    ).resolves.toBe(true)

    expect(runFfmpeg).toHaveBeenCalledTimes(1)
    await expect(fs.readFile(mergedPath, 'utf8')).resolves.toBe('merged-data')
    await Promise.all(
      segmentPaths.map((segmentPath) =>
        expect(fs.stat(segmentPath)).rejects.toThrow(),
      ),
    )
    await Promise.all(
      writtenConcatLists.map((concatListPath) =>
        expect(fs.stat(concatListPath)).rejects.toThrow(),
      ),
    )
  })

  it('warns and returns false when it cannot write the concat input list', async () => {
    const tempDir = await createTempDir(tempDirs)
    const outputDirPath = path.join(tempDir, 'blocked-output-dir')
    const warn = vi.fn()

    await fs.writeFile(outputDirPath, 'not-a-directory', 'utf8')

    await expect(
      mergeSegmentPathsToOutput({
        deleteSegments: false,
        ffmpegOperation: 'segment merge',
        mergedPath: path.join(tempDir, 'merged.webm'),
        outputDir: outputDirPath,
        runFfmpeg: vi.fn(async () => true),
        segmentPaths: [
          path.join(tempDir, 'part1.webm'),
          path.join(tempDir, 'part2.webm'),
        ],
        warn,
        writeFailureContext: 'deferred merge',
      }),
    ).resolves.toBe(false)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain(
      'Failed to write deferred merge input list',
    )
  })
})

const createTempDir = async (tempDirs: string[]): Promise<string> => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wdio-video-post-process-unit-'),
  )
  tempDirs.push(tempDir)
  return tempDir
}
