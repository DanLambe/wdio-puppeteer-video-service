import fs from 'node:fs/promises'
import path from 'node:path'
import {
  ARTIFACT_PATH_CANDIDATE_LIMIT,
  getCollisionPath,
} from './artifact-integrity.js'

export const FRAMES_EXTENSION = '.frames.mkv'

/** Creates a second name for a file; fails with `EEXIST` if it is taken. */
export type LinkFile = (existingPath: string, newPath: string) => Promise<void>

export type FramesFileMove =
  | {
      readonly framesPath: string
      /** Whether the spool's own name is gone, leaving only the frames file. */
      readonly spoolRemoved: boolean
    }
  | { readonly error: unknown }

export interface FramesFileMoveOptions {
  readonly linkFile: LinkFile
  /** The segment the frames belong to: its name and directory are used. */
  readonly plannedPath: string
  /** Removes the spool's own name once the frames file exists. */
  readonly removeSpool: (spoolPath: string) => Promise<boolean>
  readonly spoolPath: string
}

/**
 * Whether two names are positively the same file: an earlier move linked the
 * frames name but could not remove the spool's. Same volume and file id, as
 * Node reports them (`dev` and `ino`; on Windows the volume serial number and
 * the 64-bit file index, read as bigints so no digit is lost), and, because a
 * file system may approximate a longer file id, the same link count, size and
 * times, which hard links share. A file id of 0 means the file system gives
 * none, and a name that cannot be inspected is not the same file either: both
 * fall back to the next collision name.
 */
const isSameFile = async (
  spoolPath: string,
  framesPath: string,
): Promise<boolean> => {
  try {
    const [spool, frames] = await Promise.all([
      fs.stat(spoolPath, { bigint: true }),
      fs.stat(framesPath, { bigint: true }),
    ])
    return (
      spool.ino !== 0n &&
      spool.nlink >= 2n &&
      spool.dev === frames.dev &&
      spool.ino === frames.ino &&
      spool.nlink === frames.nlink &&
      spool.size === frames.size &&
      spool.mtimeNs === frames.mtimeNs &&
      spool.ctimeNs === frames.ctimeNs &&
      spool.birthtimeNs === frames.birthtimeNs
    )
  } catch {
    return false
  }
}

/**
 * Moves a spool to `<name>.frames.mkv` beside its planned segment with a hard
 * link, then removes the spool's name. A name that is taken moves on to the
 * next collision name, so an existing file is never replaced, unless it is
 * this spool's own frames file from an earlier move that could not remove the
 * spool: then that file is kept and only the spool's name is removed. A spool
 * that cannot be linked stays where it is.
 */
export const moveSpoolToFramesFile = async (
  options: FramesFileMoveOptions,
): Promise<FramesFileMove> => {
  for (
    let collisionIndex = 1;
    collisionIndex <= ARTIFACT_PATH_CANDIDATE_LIMIT;
    collisionIndex += 1
  ) {
    const candidate = getCollisionPath(options.plannedPath, collisionIndex)
    const parsed = path.parse(candidate)
    const framesPath = path.join(
      parsed.dir,
      `${parsed.name}${FRAMES_EXTENSION}`,
    )
    try {
      // A second name in the same directory tree: nothing is copied, and an
      // existing file is never replaced.
      await options.linkFile(options.spoolPath, framesPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { error }
      }
      if (!(await isSameFile(options.spoolPath, framesPath))) {
        continue
      }
    }
    return {
      framesPath,
      spoolRemoved: await options.removeSpool(options.spoolPath),
    }
  }
  return {
    error: new Error(
      `every candidate name for ${options.plannedPath} is taken`,
    ),
  }
}

/** The one-line FFmpeg command that turns a frames file into a video. */
export const describeConversion = (
  framesPath: string,
  plannedPath: string,
): string => {
  const parsed = path.parse(plannedPath)
  const target = path.join(parsed.dir, `${parsed.name}.converted.webm`)
  return `ffmpeg -i "${framesPath}" -pix_fmt yuv420p "${target}"`
}
