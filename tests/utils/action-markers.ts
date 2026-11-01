import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * A strip of black and white cells a fixture page draws in its top-right
 * corner: two guard cells, the tab's identity, its click count in binary, most
 * significant bit first, and a closing guard cell. A tab keeps its identity
 * whatever else it animates, so a decoded frame names the tab it shows and how
 * many of that tab's actions had happened. The guards at both ends reject a
 * frame whose strip is shifted or scaled, such as one caught while the
 * recorder restores the page's viewport.
 */
export const MARKER_CELL_PX = 48
export const MARKER_VALUE_BITS = 4
export const MARKER_CELLS = 4 + MARKER_VALUE_BITS
/** Distance from the viewport's top and right edges, in CSS pixels. */
export const MARKER_INSET_PX = 16
/** The viewport width the fixture is laid out for. */
export const MARKER_VIEWPORT_WIDTH = 1920

export type MarkerTab = 1 | 2

export interface Marker {
  readonly tab: MarkerTab
  readonly value: number
}

export interface MarkerFrame {
  /** Seconds, from the decoded frame's own timestamp. */
  readonly time: number
  /** Absent when the frame shows no readable strip, such as a blank page. */
  readonly marker?: Marker
}

/** Which cells are black for a tab's strip at a click count. */
export const markerCells = (tab: MarkerTab, value: number): boolean[] => {
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value >= 2 ** MARKER_VALUE_BITS
  ) {
    throw new RangeError(`Marker value out of range: ${value}`)
  }
  const bits = Array.from(
    { length: MARKER_VALUE_BITS },
    (_, bit) => ((value >> (MARKER_VALUE_BITS - 1 - bit)) & 1) === 1,
  )
  return [true, false, tab === 1, ...bits, false]
}

// Each cell is sampled as a 4×4 block and read from its middle 2×2, away
// from the edges a video encoder blurs into its neighbours.
const SAMPLES_PER_CELL = 4
const SAMPLE_WIDTH = MARKER_CELLS * SAMPLES_PER_CELL
const FRAME_BYTES = SAMPLE_WIDTH * SAMPLES_PER_CELL * 3
const DARK = 80
const LIGHT = 175

const cellLuma = (pixels: Uint8Array, offset: number, cell: number): number => {
  let total = 0
  for (const row of [1, 2]) {
    for (const column of [1, 2]) {
      const index =
        offset + (row * SAMPLE_WIDTH + cell * SAMPLES_PER_CELL + column) * 3
      total +=
        (pixels[index] ?? 0) +
        (pixels[index + 1] ?? 0) +
        (pixels[index + 2] ?? 0)
    }
  }
  return total / 12
}

/**
 * Reads one sampled frame. Any cell that is neither clearly dark nor clearly
 * light, or guard cells out of place, make the frame unreadable.
 */
export const readMarker = (
  pixels: Uint8Array,
  offset = 0,
): Marker | undefined => {
  const dark: boolean[] = []
  for (let cell = 0; cell < MARKER_CELLS; cell += 1) {
    const luma = cellLuma(pixels, offset, cell)
    if (luma > DARK && luma < LIGHT) {
      return undefined
    }
    dark.push(luma <= DARK)
  }
  if (!dark[0] || dark[1] || dark.at(-1)) {
    return undefined
  }
  const value = dark
    .slice(3, -1)
    .reduce((total, bit) => total * 2 + (bit ? 1 : 0), 0)
  return { tab: dark[2] ? 1 : 2, value }
}

/** FFmpeg filters that reduce each frame to the strip's sample grid. */
export const markerFilter = (): string => {
  const width = MARKER_CELLS * MARKER_CELL_PX
  const x = MARKER_VIEWPORT_WIDTH - MARKER_INSET_PX - width
  return [
    // A recorder may scale the viewport; restore its CSS pixel width first.
    `scale=${MARKER_VIEWPORT_WIDTH}:-2:flags=bicubic`,
    `crop=${width}:${MARKER_CELL_PX}:${x}:${MARKER_INSET_PX}`,
    `scale=${SAMPLE_WIDTH}:${SAMPLES_PER_CELL}:flags=area`,
    'format=rgb24',
    'showinfo',
  ].join(',')
}

/**
 * Decodes every frame at its own timestamp. `passthroughArgs` keeps FFmpeg
 * from repeating or dropping frames onto a constant rate.
 */
export const decodeMarkerFrames = async (
  ffmpegPath: string,
  filePath: string,
  passthroughArgs: readonly string[],
): Promise<MarkerFrame[]> => {
  const { stdout, stderr } = await promisify(execFile)(
    ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-i',
      filePath,
      '-vf',
      markerFilter(),
      ...passthroughArgs,
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
    },
  )
  const times = [...stderr.toString().matchAll(/pts_time:\s*(-?[\d.]+)/gu)].map(
    (match) => Number(match[1]),
  )
  const count = stdout.length / FRAME_BYTES
  if (!Number.isInteger(count) || count !== times.length) {
    throw new Error(
      `Decoded ${stdout.length} bytes for ${times.length} frames of ${filePath}`,
    )
  }
  return times.map((time, frame) => {
    const marker = readMarker(stdout, frame * FRAME_BYTES)
    return marker ? { time, marker } : { time }
  })
}

export interface SegmentExpectation {
  readonly tab: MarkerTab
  /**
   * The tab's click counts in order: before its first action, then after
   * each one. A segment must open on the first and reach the last.
   */
  readonly values: readonly number[]
}

/**
 * What each segment of the switching workload must show. The first tab is
 * recorded, then the opened one, then each crossing, which clicks its tab
 * once.
 */
export const switchingSegments = (crossings: number): SegmentExpectation[] => [
  { tab: 1, values: [0] },
  { tab: 2, values: [0] },
  ...Array.from({ length: crossings }, (_, crossing): SegmentExpectation => {
    const visit = Math.floor(crossing / 2) + 1
    return {
      tab: crossing % 2 === 0 ? 1 : 2,
      values: [visit - 1, visit],
    }
  }),
]

export interface SegmentCheck {
  readonly ok: boolean
  readonly reason?: string
  /** The tab's click counts the segment shows, repeats collapsed. */
  readonly observed: readonly number[]
  /** Readable frames of the other tab before the expected one appears. */
  readonly leadingOtherTab: number
  readonly unreadable: number
  /** Seconds from the segment's first frame to its first action's result. */
  readonly firstActionAt?: number
}

/** A segment may open on a frame or two of the tab it left. */
export const MAX_LEADING_OTHER_TAB = 2

/** Whether every value appears in `expected`, in order, with none repeated. */
const inOrder = (observed: readonly number[], expected: readonly number[]) => {
  let position = 0
  for (const value of observed) {
    const found = expected.indexOf(value, position)
    if (found < 0) {
      return false
    }
    position = found + 1
  }
  return true
}

const collapse = (frames: readonly MarkerFrame[]): number[] => {
  const values: number[] = []
  for (const { marker } of frames) {
    if (marker && marker.value !== values.at(-1)) {
      values.push(marker.value)
    }
  }
  return values
}

const findReason = (
  frames: readonly MarkerFrame[],
  expected: SegmentExpectation,
  observed: readonly number[],
  start: number,
  leadingOtherTab: number,
): string | undefined => {
  if (start < 0) {
    return `tab ${expected.tab} never appears`
  }
  // Frames before the tab's first readable one are its page still loading,
  // which a static page can outnumber: it paints only a few frames once loaded.
  const own = frames.slice(start)
  if (own.filter((frame) => !frame.marker).length * 2 > own.length) {
    return 'mostly unreadable'
  }
  if (leadingOtherTab > MAX_LEADING_OTHER_TAB) {
    return 'opens on the previous tab for too long'
  }
  if (
    frames
      .slice(start)
      .some((frame) => (frame.marker?.tab ?? expected.tab) !== expected.tab)
  ) {
    return 'shows another tab after its own'
  }
  if (observed[0] !== expected.values[0]) {
    return `opens at click ${observed[0]}, after its first action`
  }
  if (!inOrder(observed, expected.values)) {
    return `shows clicks ${observed.join(',')} out of order`
  }
  if (observed.at(-1) !== expected.values.at(-1)) {
    return `ends at click ${observed.at(-1)}, before its last action`
  }
  return undefined
}

/**
 * Whether a segment filmed its tab from before the first action through the
 * last one: it opens on the tab's previous state, shows its actions' results
 * in order, and shows no other tab once its own appears.
 */
export const checkSegment = (
  frames: readonly MarkerFrame[],
  expected: SegmentExpectation,
): SegmentCheck => {
  const start = frames.findIndex((frame) => frame.marker?.tab === expected.tab)
  // Readable frames before the tab's own are the tab it left.
  const leadingOtherTab = frames
    .slice(0, Math.max(0, start))
    .filter((frame) => frame.marker).length
  const own = start < 0 ? [] : frames.slice(start)
  const observed = collapse(
    own.filter((frame) => frame.marker?.tab === expected.tab),
  )
  const reason = findReason(frames, expected, observed, start, leadingOtherTab)
  const first = own.find(
    (frame) =>
      frame.marker?.tab === expected.tab &&
      frame.marker.value !== expected.values[0],
  )
  return {
    ok: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
    observed,
    leadingOtherTab,
    unreadable: frames.filter((frame) => !frame.marker).length,
    ...(first && frames[0]
      ? { firstActionAt: first.time - frames[0].time }
      : {}),
  }
}
