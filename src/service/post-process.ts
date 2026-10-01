import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { publishAtomicArtifact } from './artifact-integrity.js'
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
      : { ffmpegArgs: [...transcodeOptions.ffmpegArgs] }),
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
            : { ffmpegArgs: [...transcodeOptions.ffmpegArgs] }),
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

// Applied to every profile. Measured against `preset medium` at CRF 23 on a
// static UI clip, `veryfast` took 1.43 s rather than 1.98 s (about 28% faster)
// for an SSIM of 0.9855 against 0.9889. Nearly all of the saving comes from the
// preset: dropping to CRF 28 as well bought only another 2% of time while SSIM
// fell to 0.9774, which is the wrong trade for a recording someone may need to
// read small text in. The `ci` profile still opts into CRF 28 for smaller
// artifacts.
const DEFAULT_H264_TRANSCODE_ARGS = [
  '-preset',
  'veryfast',
  '-crf',
  '23',
] as const

const FPS_MODE_PASSTHROUGH = ['-fps_mode', 'passthrough'] as const

/**
 * Keep each frame's timestamp instead of repeating frames onto a constant
 * rate. Recordings hold an unchanged page as one frame, so a constant-rate
 * transcode would re-encode every repeat and size the final frame by guessing.
 * FFmpeg 5.1 introduced `-fps_mode` and 9.0 removed `-vsync`, so the spelling
 * follows the detected version; an unrecognized version string is a recent
 * development build.
 */
export const resolveTimestampPassthroughArgs = (
  version: string | undefined,
): readonly string[] => {
  const match = /^n?(\d+)\.(\d+)/u.exec(version ?? '')
  if (!match) {
    return FPS_MODE_PASSTHROUGH
  }
  const major = Number(match[1])
  const minor = Number(match[2])
  return major < 5 || (major === 5 && minor < 1)
    ? ['-vsync', 'passthrough']
    : FPS_MODE_PASSTHROUGH
}

export const buildH264TranscodeArgs = (
  inputPath: string,
  outputPath: string,
  ffmpegArgs: string[] | undefined,
  timestampArgs: readonly string[] = FPS_MODE_PASSTHROUGH,
): string[] => {
  return [
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
    ...timestampArgs,
    // With kept timestamps, B-frame reordering makes the MP4 muxer size the
    // track from decode times: a 1.6 s recording of sparse frames claimed to
    // last 0.67 s. A held page gains nothing from B-frames anyway.
    '-bf',
    '0',
    // Speed up the default preset while retaining CRF 23. Configured arguments
    // follow, so callers can still override both the preset and quality.
    ...DEFAULT_H264_TRANSCODE_ARGS,
    ...(ffmpegArgs ?? []),
    outputPath,
  ]
}

export const buildConcatMergeArgs = (
  concatListPath: string,
  mergedPath: string,
): string[] => {
  return [
    '-n',
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

export const buildMediaValidationArgs = (inputPath: string): string[] => {
  return [
    '-v',
    'error',
    '-xerror',
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    '-f',
    'null',
    '-',
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
}): Promise<string | undefined> => {
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
    return undefined
  }

  const publishedPath = await publishAtomicArtifact({
    desiredPath: mergedPath,
    produce: async (temporaryPath) => {
      if (segmentPaths.length === 1) {
        const singleSegmentPath = segmentPaths[0]
        if (!singleSegmentPath) {
          return false
        }
        return copySingleSegment(singleSegmentPath, temporaryPath)
      }

      return produceMergedArtifact({
        concatListPath: path.join(
          outputDir,
          `${path.parse(mergedPath).name}_concat_${randomUUID()}.txt`,
        ),
        ffmpegOperation,
        runFfmpeg,
        segmentPaths,
        temporaryPath,
        warn,
        writeFailureContext,
      })
    },
    validate: (temporaryPath) =>
      runFfmpeg(
        buildMediaValidationArgs(temporaryPath),
        `${ffmpegOperation} validation`,
      ),
    warn,
  })
  if (!publishedPath) {
    return undefined
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

  return publishedPath
}

const copySingleSegment = async (
  singleSegmentPath: string,
  temporaryPath: string,
): Promise<boolean> => {
  try {
    await fs.copyFile(singleSegmentPath, temporaryPath)
    return true
  } catch {
    return false
  }
}

const produceMergedArtifact = async (options: {
  concatListPath: string
  ffmpegOperation: string
  runFfmpeg: (args: string[], operation: string) => Promise<boolean>
  segmentPaths: string[]
  temporaryPath: string
  warn: (message: string) => void
  writeFailureContext: string
}): Promise<boolean> => {
  const wroteConcatList = await fs
    .writeFile(
      options.concatListPath,
      buildConcatList(options.segmentPaths),
      'utf8',
    )
    .then(() => true)
    .catch((error: unknown) => {
      options.warn(
        `[WdioPuppeteerVideoService] Failed to write ${options.writeFailureContext} input list: ${String(error)}`,
      )
      return false
    })
  if (!wroteConcatList) {
    return false
  }

  try {
    return await options.runFfmpeg(
      buildConcatMergeArgs(options.concatListPath, options.temporaryPath),
      options.ffmpegOperation,
    )
  } finally {
    await fs.unlink(options.concatListPath).catch(() => {
      /* best-effort cleanup */
    })
  }
}
