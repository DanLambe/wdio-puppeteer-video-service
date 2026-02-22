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
  format: OutputFormat | undefined,
): string => {
  const resolvedFormat = format ?? 'webm'
  const fileStem = currentTestSlug || 'test'
  const filename = `${fileStem}_part${currentSegment}.${resolvedFormat}`
  return path.join(outputDir || DEFAULT_OUTPUT_DIR, filename)
}

export const getMergedOutputPath = (
  outputDir: string | undefined,
  currentTestSlug: string,
  format: OutputFormat | undefined,
): string => {
  const resolvedFormat = format ?? 'webm'
  const fileStem = currentTestSlug || 'test'
  const filename = `${fileStem}.${resolvedFormat}`
  return path.join(outputDir || DEFAULT_OUTPUT_DIR, filename)
}

export const extractPartNumber = (filePath: string): number => {
  const partMatch = new RegExp(/_part(\d+)\./).exec(path.basename(filePath))
  if (!partMatch) {
    return Number.MAX_SAFE_INTEGER
  }

  return Number.parseInt(partMatch[1], 10)
}

export const buildConcatList = (segmentPaths: string[]): string => {
  return segmentPaths
    .map((filePath) => {
      const normalizedPath = path.resolve(filePath).replaceAll('\\', '/')
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
  const extension = path.extname(segmentPaths[0]).toLowerCase()
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
