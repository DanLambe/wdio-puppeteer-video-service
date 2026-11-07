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

type PaintedSpan = ColorSpan & { readonly color: SolidColor }

/**
 * The spans that show a tab's color. A recording can open before its page has
 * painted, on a slow host for longer than the page is then shown, and those
 * neutral frames belong to no tab.
 */
const paintedSpans = (
  spans: readonly ColorSpan[],
): readonly [PaintedSpan, ...PaintedSpan[]] => {
  if (spans.length === 0) {
    throw new Error('A segment decoded to no frames')
  }
  const [first, ...rest] = spans.filter(
    (span): span is PaintedSpan => span.color !== 'neutral',
  )
  if (!first) {
    throw new Error('A segment shows no painted frames')
  }
  return [first, ...rest]
}

/**
 * The color a segment shows for longest. A tab switch may leave a frame or two
 * of the previous page at a segment's edges, so a brief color does not count.
 */
export const dominantColor = (spans: readonly ColorSpan[]): SolidColor => {
  const painted = paintedSpans(spans)
  const durations = new Map<SolidColor, number>()
  for (const span of painted) {
    durations.set(
      span.color,
      (durations.get(span.color) ?? 0) + span.end - span.start,
    )
  }
  let dominant = painted[0].color
  for (const [color, duration] of durations) {
    if (duration > (durations.get(dominant) ?? 0)) {
      dominant = color
    }
  }
  return dominant
}

/** The first color a segment's painted frames show. */
export const firstColor = (spans: readonly ColorSpan[]): SolidColor => {
  return paintedSpans(spans)[0].color
}
