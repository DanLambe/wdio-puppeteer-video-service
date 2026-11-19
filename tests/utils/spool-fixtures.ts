import {
  createMatroskaHeader,
  encodeElementSize,
  MatroskaBlockWriter,
  type MatroskaTrackOptions,
} from '../../src/service/matroska-writer.js'

/** A UUID of the shape `randomUUID` returns, distinct per index. */
export const testSpoolUuid = (index = 1): string =>
  `0f1e2d3c-4b5a-4968-8776-${index.toString(16).padStart(12, '0')}`

/** The name a worker gives a segment's spool: `<slug>_part<N>.<uuid>.mkv`. */
export const spoolName = (slug: string, part: number, index = 1): string =>
  `${slug}_part${part.toString()}.${testSpoolUuid(index)}.mkv`

const BLOCK_GROUP = 0xa0
const BLOCK = 0xa1
const BLOCK_DURATION = 0x9b

/** A one-byte-id Matroska element. */
export const ebmlElement = (id: number, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from([id]), encodeElementSize(body.length), body])

/** The writer's cluster opening: its id, unknown size and timestamp. */
export const clusterOpening = (): Buffer =>
  Buffer.concat(new MatroskaBlockWriter().frame(Buffer.alloc(0), 0).slice(0, 3))

/**
 * A valid Matroska stream whose one image is in a `BlockGroup/Block`, which
 * the service's writer never produces (it writes `SimpleBlock`s), so a
 * recovery that only knows the writer's shapes cannot prove it frameless.
 */
export const blockGroupStream = (
  image: Buffer,
  track: MatroskaTrackOptions,
): Buffer => {
  // Track 1, timestamp offset 0, no flags.
  const block = Buffer.concat([Buffer.from([0x81, 0, 0, 0]), image])
  return Buffer.concat([
    createMatroskaHeader(track),
    clusterOpening(),
    ebmlElement(
      BLOCK_GROUP,
      Buffer.concat([
        ebmlElement(BLOCK, block),
        ebmlElement(BLOCK_DURATION, Buffer.from([40])),
      ]),
    ),
  ])
}
