export interface MediaDimensions {
  readonly width: number
  readonly height: number
}

export const buildMediaMetadataArgs = (inputPath: string): string[] => [
  '-hide_banner',
  '-nostdin',
  '-i',
  inputPath,
  '-map',
  '0:v:0',
  '-c:v',
  'copy',
  '-frames:v',
  '0',
  '-f',
  'null',
  '-',
]

export const parseMediaDimensions = (
  metadata: string,
): MediaDimensions | undefined => {
  const streamLine = metadata
    .split(/\r?\n/u)
    .find((line) => /^\s*Stream #0:\d+/u.test(line) && line.includes('Video:'))
  const dimensions = /,\s*(\d+)x(\d+)\b/u.exec(streamLine ?? '')
  if (!dimensions) {
    return undefined
  }
  const width = Number(dimensions[1])
  const height = Number(dimensions[2])
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return undefined
  }
  return { width, height }
}
