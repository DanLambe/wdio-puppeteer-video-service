import path from 'node:path'
import type { ScreencastSpool } from './frame-sink.js'
import { createFfmpegArguments } from './screencast-arguments.js'
import type { FfmpegResult } from './screencast-encoder.js'

/** One FFmpeg process to run to completion. */
export interface SpoolEncodeProcess {
  readonly args: string[]
  readonly ffmpegPath: string
  /** Names the work in the runner's logs. */
  readonly operation: string
}

/**
 * Runs FFmpeg and reports how it exited, with the end of its error output.
 * Rejects only when the process could not be run at all.
 */
export type SpoolEncodeRunner = (
  process: SpoolEncodeProcess,
) => Promise<FfmpegResult>

export interface SpoolEncodeRequest {
  readonly ffmpegPath: string
  /** The segment file to write; it replaces any placeholder there. */
  readonly outputPath: string
  readonly spool: ScreencastSpool
}

export type SpoolEncodeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

const SPOOL_ENCODE_OPERATION = 'spool encode'

/**
 * Encodes a spool into its segment file with the arguments a live encoder of
 * the same recording would have used, reading the spool in place of `pipe:0`.
 */
export const encodeSpool = async (
  request: SpoolEncodeRequest,
  run: SpoolEncodeRunner,
): Promise<SpoolEncodeResult> => {
  const { settings } = request.spool
  // FFmpeg reads a name that starts with `-` as an option, and one with a
  // colon as a protocol. An absolute path is neither.
  const args = createFfmpegArguments(
    { ...settings, outputPath: path.resolve(request.outputPath) },
    settings.canvas,
    settings.crop,
    path.resolve(request.spool.path),
  )
  let result: FfmpegResult
  try {
    result = await run({
      args,
      ffmpegPath: request.ffmpegPath,
      operation: SPOOL_ENCODE_OPERATION,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      reason: `FFmpeg could not encode the frame spool: ${message}`,
    }
  }
  const { code, diagnostic, signal } = result
  if (code === 0 && signal === null) {
    return { ok: true }
  }
  const exit = signal
    ? `was terminated by ${signal}`
    : `exited with code ${String(code)}`
  const detail = diagnostic ? `: ${diagnostic}` : '.'
  return {
    ok: false,
    reason: `FFmpeg ${exit} while encoding the frame spool${detail}`,
  }
}
