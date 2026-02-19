import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

type VideoFileNameStyle = 'test' | 'session' | 'sessionFull'

interface VideoArtifactAssertionOptions {
  resultsDir: string
  expectedTitles: string[]
  expectVideos: boolean
  expectZeroVideos?: boolean
  mergeSegmentsEnabled?: boolean
  fileNameStyle?: VideoFileNameStyle
  runLabel: string
}

const toFileToken = (value: string): string => {
  const input = value.toLowerCase()
  if (!input) {
    return ''
  }

  let normalized = ''
  let pendingUnderscore = false

  for (const char of input) {
    if (isLowerAlphaNumericChar(char)) {
      if (pendingUnderscore && normalized.length > 0) {
        normalized += '_'
      }
      normalized += char
      pendingUnderscore = false
      continue
    }

    pendingUnderscore = true
  }

  return normalized
}

const isLowerAlphaNumericChar = (char: string): boolean => {
  const code = char.codePointAt(0)
  if (code === undefined) {
    return false
  }

  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57)
}

const escapeRegExp = (value: string): string => {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

const toTitlePattern = (
  title: string,
  mergeSegmentsEnabled: boolean,
  fileNameStyle: VideoFileNameStyle,
): RegExp => {
  const suffix = mergeSegmentsEnabled
    ? String.raw`\.(mp4|webm)$`
    : String.raw`_part\d+\.(mp4|webm)$`
  const runToken = String.raw`(?:_run\d+)?`
  const retryToken = String.raw`(?:_retry\d+)?`

  if (fileNameStyle === 'session') {
    return new RegExp(`^[a-z0-9]{1,12}${retryToken}${runToken}${suffix}`)
  }

  if (fileNameStyle === 'sessionFull') {
    return new RegExp(`^[a-z0-9_]{8,64}${retryToken}${runToken}${suffix}`)
  }

  const slug = toFileToken(title)
  return new RegExp(
    `^${escapeRegExp(slug)}_[a-z0-9]{1,12}_[a-f0-9]{8}${retryToken}${runToken}${suffix}`,
  )
}

const warnSmallFiles = async (
  mediaFiles: string[],
  resultsDir: string,
  runLabel: string,
): Promise<void> => {
  for (const file of mediaFiles) {
    const filePath = path.join(resultsDir, file)
    const fileSize = await stat(filePath)
      .then((stats) => stats.size)
      .catch(() => 0)
    if (fileSize < 1_024) {
      console.warn(
        `[wdio:e2e:${runLabel}] Video file ${file} is very small (${fileSize} bytes)`,
      )
    }
  }
}

export const assertVideoArtifacts = async ({
  resultsDir,
  expectedTitles,
  expectVideos,
  expectZeroVideos = false,
  mergeSegmentsEnabled = false,
  fileNameStyle = 'test',
  runLabel,
}: VideoArtifactAssertionOptions): Promise<void> => {
  const files = await readdir(resultsDir).catch(() => [])
  const mediaFiles = files.filter(
    (file) => file.endsWith('.mp4') || file.endsWith('.webm'),
  )

  if (expectZeroVideos) {
    if (mediaFiles.length > 0) {
      throw new Error(
        `Expected no video files in ${resultsDir}, but found: ${mediaFiles.join(', ')}`,
      )
    }

    console.log(
      `[wdio:e2e:${runLabel}] Verified no video artifacts were generated (expectZeroVideos=true, dir=${resultsDir}).`,
    )
    return
  }

  if (mediaFiles.length === 0) {
    if (!expectVideos) {
      console.warn(
        `[wdio:e2e:${runLabel}] No video files were generated in ${resultsDir}. Skipping artifact assertions because WDIO_EXPECT_VIDEOS=${process.env.WDIO_EXPECT_VIDEOS ?? '0'}.`,
      )
      return
    }
    throw new Error(`No video files were generated in ${resultsDir}`)
  }

  await warnSmallFiles(mediaFiles, resultsDir, runLabel)

  const missingTitles: string[] = []
  for (const title of expectedTitles) {
    const pattern = toTitlePattern(title, mergeSegmentsEnabled, fileNameStyle)
    const hasArtifact = mediaFiles.some((file) => pattern.test(file))
    if (!hasArtifact) {
      missingTitles.push(title)
    }
  }

  if (missingTitles.length > 0) {
    throw new Error(
      `Missing video artifacts for tests: ${missingTitles.join(', ')}`,
    )
  }

  if (mergeSegmentsEnabled) {
    const partArtifacts = mediaFiles.filter((file) => /_part\d+\./.test(file))
    if (partArtifacts.length > 0) {
      throw new Error(
        `Expected merged artifacts only, but found segment parts: ${partArtifacts.join(', ')}`,
      )
    }
  }

  console.log(
    `[wdio:e2e:${runLabel}] Verified ${mediaFiles.length} artifacts (style=${fileNameStyle}, merge=${mergeSegmentsEnabled}, expectVideos=${expectVideos}, dir=${resultsDir}).`,
  )
}

export const listVideoArtifacts = async (
  resultsDir: string,
): Promise<string[]> => {
  const files = await readdir(resultsDir).catch(() => [])
  return files
    .filter((file) => file.endsWith('.mp4') || file.endsWith('.webm'))
    .sort((a, b) => a.localeCompare(b))
}

export { toFileToken }
