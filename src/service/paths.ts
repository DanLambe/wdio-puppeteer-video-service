import path from 'node:path'
import {
  DEFAULT_OUTPUT_DIR,
  type OutputFormat,
  SEGMENT_EXTENSION_TO_FORMAT,
} from './constants.js'

/**
 * Path and filename helpers for segment and merged video artifacts.
 */

export const collectCurrentTestSegmentPaths = (
  currentTestSlug: string,
  recordedSegments: Iterable<string>,
): string[] => {
  if (!currentTestSlug) {
    return []
  }

  const segmentPrefix = `${currentTestSlug}_part`
  return [...recordedSegments]
    .filter((filePath) => path.basename(filePath).startsWith(segmentPrefix))
    .sort(
      (leftPath, rightPath) =>
        extractPartNumber(leftPath) - extractPartNumber(rightPath),
    )
}

export const getSegmentPath = (
  outputDir: string | undefined,
  currentTestSlug: string,
  currentSegment: number,
  resolvedFormat = 'webm',
): string => {
  const fileStem = currentTestSlug || 'test'
  const filename = `${fileStem}_part${currentSegment}.${resolvedFormat}`
  return path.join(outputDir || DEFAULT_OUTPUT_DIR, filename)
}

export const getMergedOutputPath = (
  outputDir: string | undefined,
  currentTestSlug: string,
  resolvedFormat = 'webm',
): string => {
  const fileStem = currentTestSlug || 'test'
  const filename = `${fileStem}.${resolvedFormat}`
  return path.join(outputDir || DEFAULT_OUTPUT_DIR, filename)
}

const PART_NUMBER_RE = /_part(\d+)\./

export const extractPartNumber = (filePath: string): number => {
  const partMatch = PART_NUMBER_RE.exec(path.basename(filePath))
  const partValue = partMatch?.[1]
  if (!partValue) {
    return Number.MAX_SAFE_INTEGER
  }

  return Number.parseInt(partValue, 10)
}

export const buildConcatList = (segmentPaths: string[]): string => {
  return segmentPaths
    .map((filePath) => {
      const normalizedPath = path.resolve(filePath).replaceAll('\\', '/')
      // ffmpeg concat demuxer: escape ' by closing the quote, adding \', then reopening
      const escapedPath = normalizedPath.replaceAll("'", String.raw`'\''`)
      return `file '${escapedPath}'`
    })
    .join('\n')
}

export const resolveMergeFormat = (
  segmentPaths: string[],
  operationName: string,
  onWarn: (message: string) => void,
): OutputFormat | undefined => {
  const firstSegmentPath = segmentPaths[0]
  if (!firstSegmentPath) {
    return undefined
  }

  const extension = path.extname(firstSegmentPath).toLowerCase()
  const mergedFormat = SEGMENT_EXTENSION_TO_FORMAT[extension]
  if (!mergedFormat) {
    onWarn(
      `[WdioPuppeteerVideoService] Unsupported segment format for ${operationName}: ${extension}`,
    )
    return undefined
  }

  const hasMixedFormats = segmentPaths.some(
    (filePath) => path.extname(filePath).toLowerCase() !== extension,
  )
  if (hasMixedFormats) {
    onWarn(
      `[WdioPuppeteerVideoService] Skipping ${operationName} because segment formats are mixed.`,
    )
    return undefined
  }

  return mergedFormat
}
