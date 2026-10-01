// Parses the recorder's streaming Matroska output back into frames, so tests
// can assert what reached FFmpeg: each image and the time it starts.

export interface MatroskaTrack {
  readonly codecId: string
  readonly codecPrivate?: Buffer
  readonly defaultDurationNs?: number
  readonly height?: number
  readonly width?: number
}

export interface MatroskaFrame {
  readonly data: Buffer
  readonly timestampMs: number
}

export interface MatroskaStream {
  readonly clusters: number
  readonly frames: MatroskaFrame[]
  readonly timestampScale?: number
  readonly track?: MatroskaTrack
}

const MASTER_IDS = new Set([
  0x1a_45_df_a3, 0x18_53_80_67, 0x15_49_a9_66, 0x16_54_ae_6b, 0xae, 0xe0,
  0x1f_43_b6_75,
])

const readVint = (
  bytes: Buffer,
  offset: number,
  keepMarker: boolean,
): { length: number; value: number; unknown: boolean } | undefined => {
  const first = bytes[offset]
  if (first === undefined || first === 0) {
    return undefined
  }
  let length = 1
  while (!(first & (0x80 >> (length - 1)))) {
    length += 1
  }
  if (offset + length > bytes.length) {
    return undefined
  }
  let value = keepMarker ? first : first & (0xff >> length)
  let allOnes = value === 0xff >> length
  for (let index = 1; index < length; index += 1) {
    const byte = bytes[offset + index] ?? 0
    value = value * 256 + byte
    allOnes &&= byte === 0xff
  }
  return { length, value, unknown: !keepMarker && allOnes }
}

const readUnsigned = (data: Buffer): number => {
  let value = 0
  for (const byte of data) {
    value = value * 256 + byte
  }
  return value
}

/** Parses complete elements, ignoring a truncated trailing element. */
export const parseMatroskaStream = (bytes: Buffer): MatroskaStream => {
  const frames: MatroskaFrame[] = []
  const track: {
    codecId?: string
    codecPrivate?: Buffer
    defaultDurationNs?: number
    height?: number
    width?: number
  } = {}
  let clusters = 0
  let clusterTimestamp = 0
  let timestampScale: number | undefined
  let offset = 0
  while (offset < bytes.length) {
    const id = readVint(bytes, offset, true)
    const size = id && readVint(bytes, offset + id.length, false)
    if (!id || !size) {
      break
    }
    const dataStart = offset + id.length + size.length
    if (MASTER_IDS.has(id.value)) {
      if (id.value === 0x1f_43_b6_75) {
        clusters += 1
      }
      // Descend into masters, including unknown-size segment and clusters.
      offset = dataStart
      continue
    }
    const dataEnd = dataStart + size.value
    if (size.unknown || dataEnd > bytes.length) {
      break
    }
    const data = bytes.subarray(dataStart, dataEnd)
    switch (id.value) {
      case 0x2a_d7_b1:
        timestampScale = readUnsigned(data)
        break
      case 0x86:
        track.codecId = data.toString('ascii')
        break
      case 0x63_a2:
        track.codecPrivate = Buffer.from(data)
        break
      case 0x23_e3_83:
        track.defaultDurationNs = readUnsigned(data)
        break
      case 0xb0:
        track.width = readUnsigned(data)
        break
      case 0xba:
        track.height = readUnsigned(data)
        break
      case 0xe7:
        clusterTimestamp = readUnsigned(data)
        break
      case 0xa3: {
        const trackNumber = readVint(data, 0, false)
        const relative = data.readInt16BE(trackNumber?.length ?? 1)
        frames.push({
          data: Buffer.from(data.subarray((trackNumber?.length ?? 1) + 3)),
          timestampMs: clusterTimestamp + relative,
        })
        break
      }
      default:
        break
    }
    offset = dataEnd
  }
  return {
    clusters,
    frames,
    ...(timestampScale === undefined ? {} : { timestampScale }),
    ...(track.codecId
      ? {
          track: {
            codecId: track.codecId,
            ...(track.codecPrivate ? { codecPrivate: track.codecPrivate } : {}),
            ...(track.defaultDurationNs === undefined
              ? {}
              : { defaultDurationNs: track.defaultDurationNs }),
            ...(track.height === undefined ? {} : { height: track.height }),
            ...(track.width === undefined ? {} : { width: track.width }),
          },
        }
      : {}),
  }
}

export interface GridFrame {
  readonly label: string
  readonly position: number
}

/** Frames as text labels at grid positions, for fake screencast payloads. */
export const gridFrames = (bytes: Buffer, fps: number): GridFrame[] => {
  return parseMatroskaStream(bytes).frames.map((frame) => ({
    label: frame.data.toString(),
    position: Math.round((frame.timestampMs * fps) / 1_000),
  }))
}

/**
 * Grid positions each label is shown for: every frame lasts until the next,
 * and the final frame one position, as FFmpeg holds a finished recording.
 */
export const spanCounts = (frames: GridFrame[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  frames.forEach((frame, index) => {
    const next = frames[index + 1]
    counts[frame.label] =
      (counts[frame.label] ?? 0) + (next ? next.position - frame.position : 1)
  })
  return counts
}
