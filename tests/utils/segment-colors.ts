import type { ColorSpan, SolidColor } from './media-timeline.js'

/** The `_partN` number of a recorded segment; a path without one is an error. */
export const segmentPartNumber = (artifactPath: string): number => {
  const match = /_part(\d+)\./u.exec(artifactPath)
  if (!match) {
    throw new Error(`Segment path has no part number: ${artifactPath}`)
  }
  return Number(match[1])
}

export const orderSegments = <T extends { readonly path: string }>(
  segments: readonly T[],
): T[] => {
  return [...segments].sort(
    (left, right) =>
      segmentPartNumber(left.path) - segmentPartNumber(right.path),
  )
}

/**
 * The color a segment shows for longest. A tab switch may leave a frame or two
 * of the previous page at a segment's edges, so a brief color does not count.
 */
export const dominantColor = (spans: readonly ColorSpan[]): SolidColor => {
  const durations = new Map<SolidColor, number>()
  for (const span of spans) {
    durations.set(
      span.color,
      (durations.get(span.color) ?? 0) + span.end - span.start,
    )
  }
  const [dominant] = [...durations].sort((left, right) => right[1] - left[1])
  if (!dominant) {
    throw new Error('A segment decoded to no frames')
  }
  return dominant[0]
}

/** The color of a segment's first decoded frame. */
export const firstColor = (spans: readonly ColorSpan[]): SolidColor => {
  const [first] = spans
  if (!first) {
    throw new Error('A segment decoded to no frames')
  }
  return first.color
}
