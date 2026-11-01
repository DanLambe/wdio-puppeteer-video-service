import { describe, expect, it } from 'vitest'
import {
  dominantColor,
  firstColor,
  orderSegments,
  segmentPartNumber,
} from '../utils/segment-colors.js'

describe('segment color verification helpers', () => {
  it('orders segments by part number, including parts beyond nine', () => {
    const segments = ['t_part10.mp4', 't_part2.mp4', 't_part1.mp4'].map(
      (path) => ({ path }),
    )

    expect(orderSegments(segments).map(({ path }) => path)).toEqual([
      't_part1.mp4',
      't_part2.mp4',
      't_part10.mp4',
    ])
    expect(segmentPartNumber('dir/name_part12.webm')).toBe(12)
  })

  it('rejects a segment path without a part number', () => {
    expect(() => segmentPartNumber('merged.mp4')).toThrow('no part number')
  })

  it('picks the longest color and the opening color', () => {
    const spans = [
      { color: 'red' as const, start: 0, end: 0.2 },
      { color: 'green' as const, start: 0.2, end: 1.4 },
      { color: 'red' as const, start: 1.4, end: 1.5 },
    ]

    expect(dominantColor(spans)).toBe('green')
    expect(firstColor(spans)).toBe('red')
  })

  it('fails instead of inventing a color for a segment without frames', () => {
    expect(() => dominantColor([])).toThrow('no frames')
    expect(() => firstColor([])).toThrow('no frames')
  })
})
