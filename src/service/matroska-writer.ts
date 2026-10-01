// A minimal streaming Matroska writer for one video track of still images.
// Each distinct screencast frame is written once with its position on the
// frame-rate grid. FFmpeg then decodes and encodes a frame only when the page
// changed, instead of once per grid position of an unchanged page.

export type MatroskaImageCodec = 'jpeg' | 'png'

export interface MatroskaTrackOptions {
  readonly codec: MatroskaImageCodec
  /**
   * Output frames per second. One step is the default frame duration, from
   * which FFmpeg also takes its encoder time base, so frames on this grid keep
   * exact timestamps.
   */
  readonly fps: number
  readonly height: number
  readonly width: number
}

const EBML = 0x1a_45_df_a3
const EBML_VERSION = 0x42_86
const EBML_READ_VERSION = 0x42_f7
const EBML_MAX_ID_LENGTH = 0x42_f2
const EBML_MAX_SIZE_LENGTH = 0x42_f3
const DOC_TYPE = 0x42_82
const DOC_TYPE_VERSION = 0x42_87
const DOC_TYPE_READ_VERSION = 0x42_85
const SEGMENT = 0x18_53_80_67
const INFO = 0x15_49_a9_66
const TIMESTAMP_SCALE = 0x2a_d7_b1
const MUXING_APP = 0x4d_80
const WRITING_APP = 0x57_41
const TRACKS = 0x16_54_ae_6b
const TRACK_ENTRY = 0xae
const TRACK_NUMBER = 0xd7
const TRACK_UID = 0x73_c5
const TRACK_TYPE = 0x83
const FLAG_LACING = 0x9c
const DEFAULT_DURATION = 0x23_e3_83
const CODEC_ID = 0x86
const CODEC_PRIVATE = 0x63_a2
const VIDEO = 0xe0
const PIXEL_WIDTH = 0xb0
const PIXEL_HEIGHT = 0xba
const CLUSTER = 0x1f_43_b6_75
const CLUSTER_TIMESTAMP = 0xe7
const SIMPLE_BLOCK = 0xa3

const APPLICATION = 'wdio-puppeteer-video-service'
const VIDEO_TRACK_TYPE = 1
const KEYFRAME_FLAG = 0x80
// The segment and each cluster end where the stream does, so neither needs a
// size that is only known after recording.
const UNKNOWN_SIZE = Buffer.from([
  0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
])
// Block timestamps are signed 16-bit millisecond offsets from their cluster.
export const MAX_CLUSTER_SPAN_MS = 30_000

const encodeId = (id: number): Buffer => {
  const bytes: number[] = []
  for (let value = id; value > 0; value = Math.floor(value / 256)) {
    bytes.unshift(value % 256)
  }
  return Buffer.from(bytes)
}

export const encodeElementSize = (size: number): Buffer => {
  for (let length = 1; length <= 8; length += 1) {
    // The all-ones value of each length is reserved for an unknown size.
    if (size < 2 ** (7 * length) - 1) {
      const bytes = Buffer.alloc(length)
      let value = size
      for (let index = length - 1; index >= 0; index -= 1) {
        bytes[index] = value % 256
        value = Math.floor(value / 256)
      }
      bytes[0] = (bytes[0] ?? 0) | (0x80 >> (length - 1))
      return bytes
    }
  }
  throw new RangeError(`Matroska element too large: ${size.toString()} bytes`)
}

const element = (id: number, payload: Buffer): Buffer => {
  return Buffer.concat([
    encodeId(id),
    encodeElementSize(payload.length),
    payload,
  ])
}

const unsigned = (id: number, value: number): Buffer => {
  const bytes: number[] = []
  let rest = value
  do {
    bytes.unshift(rest % 256)
    rest = Math.floor(rest / 256)
  } while (rest > 0)
  return element(id, Buffer.from(bytes))
}

const text = (id: number, value: string): Buffer => {
  return element(id, Buffer.from(value, 'ascii'))
}

// A BITMAPINFOHEADER whose `MPNG` tag FFmpeg maps to its PNG decoder, the
// same codec description FFmpeg writes for PNG in Matroska.
const pngCodecPrivate = (width: number, height: number): Buffer => {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(header.length, 0)
  header.writeInt32LE(width, 4)
  header.writeInt32LE(height, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(24, 14)
  header.write('MPNG', 16, 'ascii')
  header.writeUInt32LE(width * height * 3, 20)
  return header
}

const codecElements = (options: MatroskaTrackOptions): Buffer => {
  if (options.codec === 'jpeg') {
    return text(CODEC_ID, 'V_MJPEG')
  }
  return Buffer.concat([
    text(CODEC_ID, 'V_MS/VFW/FOURCC'),
    element(CODEC_PRIVATE, pngCodecPrivate(options.width, options.height)),
  ])
}

/** The stream header: everything before the first frame. */
export const createMatroskaHeader = (options: MatroskaTrackOptions): Buffer => {
  return Buffer.concat([
    element(
      EBML,
      Buffer.concat([
        unsigned(EBML_VERSION, 1),
        unsigned(EBML_READ_VERSION, 1),
        unsigned(EBML_MAX_ID_LENGTH, 4),
        unsigned(EBML_MAX_SIZE_LENGTH, 8),
        text(DOC_TYPE, 'matroska'),
        unsigned(DOC_TYPE_VERSION, 4),
        unsigned(DOC_TYPE_READ_VERSION, 2),
      ]),
    ),
    encodeId(SEGMENT),
    UNKNOWN_SIZE,
    element(
      INFO,
      Buffer.concat([
        // Timestamps are in milliseconds.
        unsigned(TIMESTAMP_SCALE, 1_000_000),
        text(MUXING_APP, APPLICATION),
        text(WRITING_APP, APPLICATION),
      ]),
    ),
    element(
      TRACKS,
      element(
        TRACK_ENTRY,
        Buffer.concat([
          unsigned(TRACK_NUMBER, 1),
          unsigned(TRACK_UID, 1),
          unsigned(TRACK_TYPE, VIDEO_TRACK_TYPE),
          unsigned(FLAG_LACING, 0),
          unsigned(DEFAULT_DURATION, Math.round(1e9 / options.fps)),
          codecElements(options),
          element(
            VIDEO,
            Buffer.concat([
              unsigned(PIXEL_WIDTH, options.width),
              unsigned(PIXEL_HEIGHT, options.height),
            ]),
          ),
        ]),
      ),
    ),
  ])
}

/**
 * Frames images as SimpleBlocks, opening a cluster when a block would fall
 * outside the current one. Returns the chunks for one image without copying
 * the image, so a caller can write them in order.
 */
export class MatroskaBlockWriter {
  private clusterStart: number | undefined

  frame(image: Buffer, timestampMs: number): Buffer[] {
    const chunks: Buffer[] = []
    if (
      this.clusterStart === undefined ||
      timestampMs - this.clusterStart > MAX_CLUSTER_SPAN_MS
    ) {
      this.clusterStart = timestampMs
      chunks.push(
        encodeId(CLUSTER),
        UNKNOWN_SIZE,
        unsigned(CLUSTER_TIMESTAMP, timestampMs),
      )
    }
    const blockHeader = Buffer.alloc(4)
    // Track number 1 as a one-byte size-style number.
    blockHeader[0] = 0x81
    blockHeader.writeInt16BE(timestampMs - this.clusterStart, 1)
    blockHeader[3] = KEYFRAME_FLAG
    chunks.push(
      encodeId(SIMPLE_BLOCK),
      encodeElementSize(blockHeader.length + image.length),
      blockHeader,
      image,
    )
    return chunks
  }
}
