import { describe, expect, it } from 'vitest'
import {
  checkSegment,
  MARKER_CELLS,
  type MarkerFrame,
  type MarkerTab,
  markerCells,
  readMarker,
  switchingSegments,
} from '../utils/action-markers.js'

// One sampled frame: each cell is a 4×4 block of a single gray level.
const sampled = (levels: readonly number[]): Uint8Array => {
  const width = MARKER_CELLS * 4
  const pixels = new Uint8Array(width * 4 * 3)
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const level = levels[Math.floor(column / 4)] ?? 0
      pixels.fill(
        level,
        (row * width + column) * 3,
        (row * width + column + 1) * 3,
      )
    }
  }
  return pixels
}

const strip = (tab: MarkerTab, value: number) =>
  sampled(markerCells(tab, value).map((dark) => (dark ? 20 : 235)))

// Frames 40 ms apart, from tab/value pairs; `undefined` is a blank frame.
const frames = (
  ...states: readonly ([MarkerTab, number] | undefined)[]
): MarkerFrame[] =>
  states.map((state, index) =>
    state
      ? { time: index * 0.04, marker: { tab: state[0], value: state[1] } }
      : { time: index * 0.04 },
  )

describe('action marker strip', () => {
  it('reads back every tab and click count it draws', () => {
    for (const tab of [1, 2] as const) {
      for (let value = 0; value < 16; value += 1) {
        expect(readMarker(strip(tab, value))).toEqual({ tab, value })
      }
    }
  })

  it('reads a frame by its offset in a decoded stream', () => {
    const first = strip(1, 3)
    const second = strip(2, 9)
    const stream = new Uint8Array(first.length + second.length)
    stream.set(first)
    stream.set(second, first.length)

    expect(readMarker(stream, first.length)).toEqual({ tab: 2, value: 9 })
  })

  it('reads nothing from a blank page, an uncertain cell or swapped guards', () => {
    expect(readMarker(sampled(Array(MARKER_CELLS).fill(255)))).toBeUndefined()
    expect(readMarker(sampled(Array(MARKER_CELLS).fill(0)))).toBeUndefined()
    const uncertain = markerCells(1, 5).map((dark): number => (dark ? 20 : 235))
    uncertain[4] = 128
    expect(readMarker(sampled(uncertain))).toBeUndefined()
    const swapped = markerCells(1, 5).map((dark): number => (dark ? 20 : 235))
    swapped[0] = 235
    swapped[1] = 20
    expect(readMarker(sampled(swapped))).toBeUndefined()
  })

  it('reads nothing from a strip shifted into black padding', () => {
    // A frame caught while the page's viewport is restored: the strip's tail
    // lands on the canvas padding, which once read as tab 1 at click 15.
    const shifted = [20, 235, ...Array(MARKER_CELLS - 2).fill(20)]

    expect(readMarker(sampled(shifted))).toBeUndefined()
  })

  it('rejects a click count the strip cannot show', () => {
    expect(() => markerCells(1, 16)).toThrow(RangeError)
    expect(() => markerCells(1, -1)).toThrow(RangeError)
    expect(() => markerCells(1, 1.5)).toThrow(RangeError)
  })
})

describe('switching segment expectations', () => {
  it('alternates tabs, clicking each once per visit', () => {
    expect(switchingSegments(4)).toEqual([
      { tab: 1, values: [0] },
      { tab: 2, values: [0] },
      { tab: 1, values: [0, 1] },
      { tab: 2, values: [0, 1] },
      { tab: 1, values: [1, 2] },
      { tab: 2, values: [1, 2] },
    ])
  })
})

describe('segment action check', () => {
  const visit = { tab: 1, values: [2, 3, 4] } as const

  it('passes a segment that opens before its first action', () => {
    const result = checkSegment(
      frames(undefined, [2, 0], [1, 2], [1, 2], [1, 3], [1, 4], [1, 4]),
      visit,
    )

    expect(result).toEqual({
      ok: true,
      observed: [2, 3, 4],
      leadingOtherTab: 1,
      unreadable: 1,
      firstActionAt: 0.16,
    })
  })

  it('passes when both clicks land in one frame', () => {
    expect(checkSegment(frames([1, 2], [1, 4]), visit).ok).toBe(true)
  })

  it('rejects a recording that starts after the first action', () => {
    // The late start the overlap experiment must not introduce: the right
    // tab, for the whole dwell, but without its first action.
    const result = checkSegment(frames([1, 3], [1, 3], [1, 4]), visit)

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('opens at click 3, after its first action')
  })

  it('rejects a segment that films the wrong tab', () => {
    expect(checkSegment(frames([2, 2], [2, 3], [2, 4]), visit).reason).toBe(
      'tab 1 never appears',
    )
    expect(
      checkSegment(frames([1, 2], [1, 3], [2, 4], [1, 4]), visit).reason,
    ).toBe('shows another tab after its own')
    expect(
      checkSegment(frames([2, 1], [2, 1], [2, 1], [1, 2], [1, 4]), visit)
        .reason,
    ).toBe('opens on the previous tab for too long')
  })

  it('rejects actions out of order or missing at the end', () => {
    expect(checkSegment(frames([1, 2], [1, 4], [1, 3]), visit).reason).toBe(
      'shows clicks 2,4,3 out of order',
    )
    expect(checkSegment(frames([1, 2], [1, 3]), visit).reason).toBe(
      'ends at click 3, before its last action',
    )
    expect(checkSegment(frames([1, 2], [1, 7], [1, 4]), visit).reason).toBe(
      'shows clicks 2,7,4 out of order',
    )
  })

  it('rejects a segment that is mostly unreadable', () => {
    expect(
      checkSegment(
        frames([1, 2], undefined, undefined, undefined, [1, 4]),
        visit,
      ).reason,
    ).toBe('mostly unreadable')
  })

  it('rejects a segment with no readable frames', () => {
    const result = checkSegment(frames(undefined, undefined), visit)

    expect(result).toEqual({
      ok: false,
      reason: 'tab 1 never appears',
      observed: [],
      leadingOtherTab: 0,
      unreadable: 2,
    })
  })
})
