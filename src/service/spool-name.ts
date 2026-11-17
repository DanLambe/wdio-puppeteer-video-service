// The one place a spool's file name is defined. A worker names each spool
// with `formatSpoolFileName`; the launcher's orphan recovery only touches
// files `parseSpoolFileName` recognizes, so the two cannot drift apart.

// `<slug>_part<N>.<uuid>.mkv`: a slug as `sanitizeFileToken` makes it, a
// segment number from 1, and a UUID as `randomUUID` returns it.
const SPOOL_FILE_NAME =
  /^([a-z\d_]+_part[1-9]\d*)\.[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.mkv$/u

export interface SpoolFileNameParts {
  readonly part: number
  readonly slug: string
  readonly uuid: string
}

/** What a recognized spool name says about its segment. */
export interface ParsedSpoolFileName {
  /** `<slug>_part<N>`, the planned segment's name without its extension. */
  readonly segmentName: string
}

export const parseSpoolFileName = (
  fileName: string,
): ParsedSpoolFileName | undefined => {
  const segmentName = SPOOL_FILE_NAME.exec(fileName)?.[1]
  return segmentName === undefined ? undefined : { segmentName }
}

/**
 * The spool name for a segment, or undefined when the parts would form a name
 * recovery does not recognize: such a spool could never be recovered, so the
 * caller records that segment without one.
 */
export const formatSpoolFileName = ({
  part,
  slug,
  uuid,
}: SpoolFileNameParts): string | undefined => {
  const segmentName = `${slug}_part${part.toString()}`
  const fileName = `${segmentName}.${uuid}.mkv`
  return parseSpoolFileName(fileName)?.segmentName === segmentName
    ? fileName
    : undefined
}
