import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { CaptureEncoding } from '../../src/types.js'

const ENCODINGS: readonly CaptureEncoding[] = ['live', 'auto', 'deferred']

/**
 * The `capture.encoding` a browser suite runs with, from
 * `WDIO_CAPTURE_ENCODING`; unset, the service's default.
 */
export const readCaptureEncoding = (): CaptureEncoding | undefined => {
  const value = process.env.WDIO_CAPTURE_ENCODING?.trim()
  if (!value) {
    return undefined
  }
  const encoding = ENCODINGS.find((candidate) => candidate === value)
  if (!encoding) {
    throw new TypeError(
      `WDIO_CAPTURE_ENCODING must be one of ${ENCODINGS.join(', ')}, got "${value}"`,
    )
  }
  return encoding
}

/** A results-directory suffix that keeps each encoding's artifacts apart. */
export const captureEncodingSuffix = (): string => {
  const encoding = readCaptureEncoding()
  return encoding ? `-${encoding}` : ''
}

/**
 * After a run, no spool is left in `.wdio-video-spool`, and no frames file
 * was kept: every kept recording was encoded, every discarded one deleted.
 * Removing the emptied run directory is the launcher's job.
 */
export const assertNoSpoolsLeft = async (resultsDir: string): Promise<void> => {
  const spoolDirectory = path.join(resultsDir, '.wdio-video-spool')
  const spools = (
    await readdir(spoolDirectory, { recursive: true }).catch((): string[] => [])
  ).filter((name) => name.endsWith('.mkv'))
  if (spools.length > 0) {
    throw new Error(
      `Expected no frame spool after the run, found: ${spools.join(', ')}`,
    )
  }
  const frames = (await readdir(resultsDir).catch((): string[] => [])).filter(
    (name) => name.endsWith('.frames.mkv'),
  )
  if (frames.length > 0) {
    throw new Error(
      `Expected every kept recording to be encoded, found frames files: ${frames.join(', ')}`,
    )
  }
}
