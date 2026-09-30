import { describe, expect, it } from 'vitest'
import {
  createMatroskaHeader,
  encodeElementSize,
  MAX_CLUSTER_SPAN_MS,
  MatroskaBlockWriter,
} from '../../src/service/matroska-writer.js'
import { parseMatroskaStream } from '../utils/matroska-blocks.js'

const write = (
  frames: Array<[string, number]>,
  codec: 'jpeg' | 'png' = 'png',
): Buffer => {
  const writer = new MatroskaBlockWriter()
  return Buffer.concat([
    createMatroskaHeader({ codec, fps: 30, width: 1921, height: 1081 }),
    ...frames.flatMap(([label, timestamp]) =>
      writer.frame(Buffer.from(label), timestamp),
    ),
  ])
}

describe('Matroska writer', () => {
  it.each([
    [0, '80'],
    [126, 'fe'],
    // All-ones is reserved for an unknown size, so 127 needs two bytes.
    [127, '407f'],
    [16_382, '7ffe'],
    [16_383, '203fff'],
    [2 ** 28 - 2, '1ffffffe'],
  ])('encodes element size %i in the shortest valid form', (size, hex) => {
    expect(encodeElementSize(size).toString('hex')).toBe(hex)
  })

  it('rejects an element larger than the format can describe', () => {
    expect(() => encodeElementSize(2 ** 56)).toThrow(RangeError)
  })

  it('describes PNG frames the way FFmpeg writes them', () => {
    const stream = parseMatroskaStream(write([]))
    expect(stream.timestampScale).toBe(1_000_000)
    expect(stream.track).toMatchObject({
      codecId: 'V_MS/VFW/FOURCC',
      defaultDurationNs: 33_333_333,
      height: 1081,
      width: 1921,
    })
    const header = stream.track?.codecPrivate as Buffer
    expect(header.readUInt32LE(0)).toBe(40)
    expect(header.readInt32LE(4)).toBe(1921)
    expect(header.readInt32LE(8)).toBe(1081)
    expect(header.toString('ascii', 16, 20)).toBe('MPNG')
  })

  it('describes JPEG frames as Motion JPEG without codec data', () => {
    const stream = parseMatroskaStream(write([], 'jpeg'))
    expect(stream.track?.codecId).toBe('V_MJPEG')
    expect(stream.track?.codecPrivate).toBeUndefined()
  })

  it('opens a new cluster before a block offset would overflow', () => {
    const stream = parseMatroskaStream(
      write([
        ['a', 0],
        ['b', MAX_CLUSTER_SPAN_MS],
        ['c', MAX_CLUSTER_SPAN_MS + 1],
        ['d', 95_000],
      ]),
    )
    expect(stream.clusters).toBe(3)
    expect(
      stream.frames.map((frame) => [frame.data.toString(), frame.timestampMs]),
    ).toEqual([
      ['a', 0],
      ['b', MAX_CLUSTER_SPAN_MS],
      ['c', MAX_CLUSTER_SPAN_MS + 1],
      ['d', 95_000],
    ])
  })

  it('returns the image itself as the last chunk, without copying it', () => {
    const image = Buffer.from('frame')
    const chunks = new MatroskaBlockWriter().frame(image, 0)
    expect(chunks.at(-1)).toBe(image)
  })
})
