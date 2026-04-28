import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  DeferredMergeTask,
  DeferredTranscodeTask,
  OutputFormat,
  ResolvedTranscodeOptions,
} from './constants.js'
import { buildConcatList } from './paths.js'

export const createDeferredTranscodeTask = (
  inputPath: string,
  outputPath: string,
  transcodeOptions: ResolvedTranscodeOptions,
): DeferredTranscodeTask => {
  return {
    kind: 'transcode',
    inputPath,
    outputPath,
    deleteOriginal: transcodeOptions.deleteOriginal,
    ...(transcodeOptions.ffmpegArgs === undefined
      ? {}
      : { ffmpegArgs: transcodeOptions.ffmpegArgs }),
  }
}

export const createDeferredMergeTask = (options: {
  deleteSegments: boolean
  getMergedOutputPath: (format: OutputFormat) => string
  mergedFormat: OutputFormat
  outputFormat: OutputFormat
  segmentPaths: string[]
  shouldTranscodeMergedOutput: boolean
  transcodeOptions: ResolvedTranscodeOptions
}): DeferredMergeTask => {
  const {
    deleteSegments,
    getMergedOutputPath,
    mergedFormat,
    outputFormat,
    segmentPaths,
    shouldTranscodeMergedOutput,
    transcodeOptions,
  } = options

  const transcodeToMp4 =
    mergedFormat === 'webm' &&
    outputFormat === 'mp4' &&
    shouldTranscodeMergedOutput
      ? {
          outputPath: getMergedOutputPath('mp4'),
          deleteOriginal: transcodeOptions.deleteOriginal,
          ...(transcodeOptions.ffmpegArgs === undefined
            ? {}
            : { ffmpegArgs: transcodeOptions.ffmpegArgs }),
        }
      : undefined

  return {
    kind: 'merge',
    segmentPaths,
    mergedPath: transcodeToMp4
      ? getMergedOutputPath('webm')
      : getMergedOutputPath(mergedFormat),
    deleteSegments,
    ...(transcodeToMp4 ? { transcodeToMp4 } : {}),
  }
}

export const buildH264TranscodeArgs = (
  inputPath: string,
  outputPath: string,
  ffmpegArgs: string[] | undefined,
): string[] => {
  return [
    '-y',
    '-i',
    inputPath,
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-vf',
    'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    ...(ffmpegArgs ?? []),
    outputPath,
  ]
}

export const buildConcatMergeArgs = (
  concatListPath: string,
  mergedPath: string,
): string[] => {
  return [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatListPath,
    '-c',
    'copy',
    mergedPath,
  ]
}

export const mergeSegmentPathsToOutput = async (options: {
  deleteSegments: boolean
  ffmpegOperation: string
  mergedPath: string
  outputDir: string
  runFfmpeg: (args: string[], operation: string) => Promise<boolean>
  segmentPaths: string[]
  warn: (message: string) => void
  writeFailureContext: string
}): Promise<boolean> => {
  const {
    deleteSegments,
    ffmpegOperation,
    mergedPath,
    outputDir,
    runFfmpeg,
    segmentPaths,
    warn,
    writeFailureContext,
  } = options
  if (segmentPaths.length === 0) {
    return false
  }

  await fs.unlink(mergedPath).catch(() => {
    /* may not exist yet */
  })

  if (segmentPaths.length === 1) {
    const singleSegmentPath = segmentPaths[0]
    if (!singleSegmentPath) {
      return false
    }

    return copyOrMoveSingleSegment(
      singleSegmentPath,
      mergedPath,
      deleteSegments,
    )
  }

  const concatListPath = path.join(
    outputDir,
    `${path.parse(mergedPath).name}_concat_${randomUUID()}.txt`,
  )
  const wroteConcatList = await fs
    .writeFile(concatListPath, buildConcatList(segmentPaths), 'utf8')
    .then(() => true)
    .catch((error: unknown) => {
      warn(
        `[WdioPuppeteerVideoService] Failed to write ${writeFailureContext} input list: ${String(error)}`,
      )
      return false
    })
  if (!wroteConcatList) {
    return false
  }

  const merged = await runFfmpeg(
    buildConcatMergeArgs(concatListPath, mergedPath),
    ffmpegOperation,
  )
  await fs.unlink(concatListPath).catch(() => {
    /* best-effort cleanup */
  })
  if (!merged) {
    return false
  }

  if (deleteSegments) {
    await Promise.all(
      segmentPaths.map((segmentPath) =>
        fs.unlink(segmentPath).catch(() => {
          /* best-effort cleanup */
        }),
      ),
    )
  }

  return true
}

const copyOrMoveSingleSegment = async (
  singleSegmentPath: string,
  mergedPath: string,
  deleteSegments: boolean,
): Promise<boolean> => {
  try {
    if (deleteSegments) {
      await fs.rename(singleSegmentPath, mergedPath).catch(async () => {
        await fs.copyFile(singleSegmentPath, mergedPath)
        await fs.unlink(singleSegmentPath).catch(() => {
          /* best-effort cleanup */
        })
      })
    } else {
      await fs.copyFile(singleSegmentPath, mergedPath)
    }
    return true
  } catch {
    return false
  }
}
