import fs from 'node:fs/promises'
import path from 'node:path'
import {
  type ClockBoundary,
  type FileSystemBoundary,
  nodeFileSystem,
  systemClock,
} from './boundaries.js'
import { SPOOL_DIR_NAME } from './constants.js'
import { removeFileWithRetry } from './file-removal.js'
import {
  describeConversion,
  FRAMES_EXTENSION,
  type LinkFile,
  moveSpoolToFramesFile,
} from './frames-file.js'
import {
  isDirectChildDirectory,
  isSafeGlobalSlotRunId,
} from './global-slot-directory.js'
import type { ServiceLogger } from './logging.js'
import { STREAM_OPENING, type StreamOpeningElement } from './matroska-writer.js'
import { describeError } from './normalization.js'
import { parseSpoolFileName } from './spool-name.js'

// The stream header and the first cluster's opening are a few hundred bytes,
// so the first block starts well inside this prefix however large its image.
const SPOOL_PREFIX_BYTES = 16 * 1_024
// The writer's header elements and cluster timestamp are each far smaller.
// A larger size is not the writer's, and skipping it could skip a frame.
const MAX_OPENING_ELEMENT_BYTES = 4 * 1_024
const LOG_PREFIX = '[WdioPuppeteerVideoService]'

/**
 * `frames`: the first block is there. `no-frames`: the file ends inside the
 * writer's opening, before any image. `unrecognized`: anything else, which is
 * kept like frames because deleting it could delete a recording.
 */
type SpoolContent = 'frames' | 'no-frames' | 'unrecognized'

const readElementSize = (
  bytes: Buffer,
  offset: number,
):
  | { readonly length: number; readonly size: number | undefined }
  | 'invalid'
  | 'truncated' => {
  const first = bytes[offset]
  if (first === undefined) {
    return 'truncated'
  }
  const length = Math.clz32(first) - 24 + 1
  if (length > 8) {
    return 'invalid'
  }
  if (offset + length > bytes.length) {
    return 'truncated'
  }
  let size = first & (0xff >> length)
  let allOnes = size === 0xff >> length
  for (let index = 1; index < length; index += 1) {
    const byte = bytes[offset + index] ?? 0
    size = size * 256 + byte
    allOnes &&= byte === 0xff
  }
  return { length, size: allOnes ? undefined : size }
}

/**
 * Reads the next element of the writer's opening at `offset`: the offset of
 * the element after it, `ended` when the bytes end first, or `unrecognized`
 * when they are anything other than exactly that element.
 */
const readOpeningElement = (
  prefix: Buffer,
  offset: number,
  expected: StreamOpeningElement,
  last: boolean,
): number | 'ended' | 'unrecognized' => {
  const id = prefix.subarray(offset, offset + expected.id.length)
  if (!id.equals(expected.id.subarray(0, id.length))) {
    return 'unrecognized'
  }
  if (id.length < expected.id.length) {
    return 'ended'
  }
  const size = readElementSize(prefix, offset + id.length)
  if (size === 'truncated') {
    return 'ended'
  }
  if (
    size === 'invalid' ||
    (size.size === undefined) !== expected.unknownSize
  ) {
    return 'unrecognized'
  }
  const length = size.size ?? 0
  if (!last && length > MAX_OPENING_ELEMENT_BYTES) {
    return 'unrecognized'
  }
  return offset + id.length + size.length + length
}

/**
 * Whether the start of a spool holds a frame, read against the exact element
 * sequence the writer starts every stream with (`STREAM_OPENING`). Only that
 * sequence, cut off before the first block has an image, is frameless: an
 * empty file, a header alone, a header with an empty cluster, or any of them
 * cut off inside an element. A complete block id and size is a frame. Every
 * other structure (a `BlockGroup`, an element the writer does not write, a
 * size it does not give) is `unrecognized`. `whole` says the prefix is the
 * whole file; a prefix that ends inside the opening while the file goes on
 * settles nothing and is `unrecognized` too.
 */
export const classifySpoolPrefix = (
  prefix: Buffer,
  whole: boolean,
): SpoolContent => {
  let offset = 0
  for (const [index, expected] of STREAM_OPENING.entries()) {
    const next = readOpeningElement(
      prefix,
      offset,
      expected,
      index === STREAM_OPENING.length - 1,
    )
    if (next === 'ended') {
      return whole ? 'no-frames' : 'unrecognized'
    }
    if (next === 'unrecognized') {
      return next
    }
    offset = next
  }
  return 'frames'
}

const readSpoolPrefix = async (
  spoolPath: string,
): Promise<{ readonly prefix: Buffer; readonly whole: boolean }> => {
  const handle = await fs.open(spoolPath, 'r')
  try {
    const buffer = Buffer.alloc(SPOOL_PREFIX_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return {
      prefix: buffer.subarray(0, bytesRead),
      whole: bytesRead < buffer.length,
    }
  } finally {
    await handle.close()
  }
}

export interface SpoolRecoveryOptions {
  readonly clock?: ClockBoundary
  readonly fileSystem?: Pick<FileSystemBoundary, 'unlink'>
  /** Creates a second name for a file; fails with `EEXIST` if it is taken. */
  readonly linkFile?: LinkFile
  readonly log: ServiceLogger
  readonly outputDir: string
  /** Removes an empty directory; fails if it holds anything. */
  readonly removeDirectory?: (directory: string) => Promise<void>
  readonly runId: string
}

export interface SpoolRecoveryResult {
  /** Spools with no frame that were deleted. */
  readonly deleted: readonly string[]
  /** Whether the run's spool directory is gone. */
  readonly directoryRemoved: boolean
  /** Spools that could not be moved or deleted, and still sit where they were. */
  readonly left: readonly { readonly path: string; readonly reason: string }[]
  /** The frames files that now hold the frames of the run's orphaned spools. */
  readonly recovered: readonly string[]
}

interface RecoveryDependencies {
  readonly clock: ClockBoundary
  readonly fileSystem: Pick<FileSystemBoundary, 'unlink'>
  readonly linkFile: LinkFile
  readonly log: ServiceLogger
  readonly outputDir: string
}

type SpoolOutcome =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'recovered'; readonly framesPath: string }
  | { readonly kind: 'left'; readonly reason: string }

/**
 * Recovers the spools a run's workers left behind (a worker killed while it
 * recorded) and removes the run's spool directory once nothing is left in it.
 * Only files named as a worker names its spools are touched. A spool with a
 * frame, or with content recovery cannot prove frameless, becomes
 * `<outputDir>/<slug>_part<N>.frames.mkv`; one that is provably frameless is
 * deleted; one that cannot be handled stays, and then so does the directory,
 * as it does for any file with another name. Only this run's directory is
 * touched, and only after the same containment check the global-slot cleanup
 * uses, with neither it nor the spool root a link. Resolves `undefined` when
 * the run has no spool directory.
 */
export const recoverOrphanedSpools = async (
  options: SpoolRecoveryOptions,
): Promise<SpoolRecoveryResult | undefined> => {
  const root = path.resolve(options.outputDir, SPOOL_DIR_NAME)
  const runDirectory = await resolveRunDirectory(root, options.runId)
  if (runDirectory === undefined) {
    return undefined
  }
  const dependencies: RecoveryDependencies = {
    clock: options.clock ?? systemClock,
    fileSystem: options.fileSystem ?? nodeFileSystem,
    linkFile: options.linkFile ?? fs.link,
    log: options.log,
    outputDir: options.outputDir,
  }
  const spools = await listSpools(runDirectory)
  const deleted: string[] = []
  const left: Array<{ path: string; reason: string }> = []
  const recovered: string[] = []
  for (const spool of spools) {
    const outcome = await recoverSpool(dependencies, spool)
    if (outcome.kind === 'recovered') {
      recovered.push(outcome.framesPath)
    } else if (outcome.kind === 'deleted') {
      deleted.push(spool.path)
    } else {
      left.push({ path: spool.path, reason: outcome.reason })
    }
  }
  warnAboutRecovery(options.log, recovered, left)
  const removeDirectory = options.removeDirectory ?? fs.rmdir
  const directoryRemoved =
    left.length === 0 &&
    (await removeEmptyDirectories(
      { log: options.log, removeDirectory },
      runDirectory,
      root,
    ))
  return { deleted, directoryRemoved, left, recovered }
}

const resolveRunDirectory = async (
  root: string,
  runId: string,
): Promise<string | undefined> => {
  if (!isSafeGlobalSlotRunId(runId)) {
    throw new TypeError(
      `${LOG_PREFIX} The launcher run ID is unsafe for spool path construction.`,
    )
  }
  const runDirectory = path.join(root, runId)
  if (!isDirectChildDirectory(root, runDirectory)) {
    throw new TypeError(
      `${LOG_PREFIX} Refusing to recover a spool path outside its configured root.`,
    )
  }
  // Both the service's spool root and the run's directory must be the plain
  // directories the workers made: a link or junction could lead anywhere.
  for (const directory of [root, runDirectory]) {
    const stats = await lstatIfPresent(directory)
    if (stats === undefined) {
      return undefined
    }
    if (!stats.isDirectory()) {
      throw new TypeError(
        `${LOG_PREFIX} Refusing to recover ${directory}: it is not a plain directory.`,
      )
    }
  }
  return runDirectory
}

const lstatIfPresent = async (
  filePath: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> => {
  try {
    return await fs.lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

interface SpoolFile {
  readonly path: string
  /** `<slug>_part<N>`, from the spool's name. */
  readonly segmentName: string
}

// Only regular files directly in the directory, named as a worker names its
// spools, are spools. Every other file is left as it is.
const listSpools = async (runDirectory: string): Promise<SpoolFile[]> => {
  const entries = await fs.readdir(runDirectory, { withFileTypes: true })
  const names = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
  const spools: SpoolFile[] = []
  for (const name of names) {
    const parsed = parseSpoolFileName(name)
    if (parsed !== undefined) {
      spools.push({
        path: path.join(runDirectory, name),
        segmentName: parsed.segmentName,
      })
    }
  }
  return spools
}

const recoverSpool = async (
  dependencies: RecoveryDependencies,
  { path: spoolPath, segmentName }: SpoolFile,
): Promise<SpoolOutcome> => {
  let content: SpoolContent
  try {
    const { prefix, whole } = await readSpoolPrefix(spoolPath)
    content = classifySpoolPrefix(prefix, whole)
  } catch (error) {
    return {
      kind: 'left',
      reason: `it could not be read: ${describeError(error)}`,
    }
  }
  const removeSpool = (filePath: string): Promise<boolean> =>
    removeFileWithRetry(
      {
        clock: dependencies.clock,
        fileSystem: dependencies.fileSystem,
        log: dependencies.log,
      },
      filePath,
      content === 'no-frames' ? 'frameless spool' : 'moved frame spool',
    )
  if (content === 'no-frames') {
    return (await removeSpool(spoolPath))
      ? { kind: 'deleted' }
      : { kind: 'left', reason: 'it holds no frame but could not be deleted' }
  }
  if (content === 'unrecognized') {
    dependencies.log(
      'debug',
      `${LOG_PREFIX} Keeping ${spoolPath} as a frames file: its structure is not one the writer produces, so it is not treated as frameless.`,
    )
  }
  const moved = await moveSpoolToFramesFile({
    linkFile: dependencies.linkFile,
    plannedPath: path.join(dependencies.outputDir, `${segmentName}.webm`),
    removeSpool,
    spoolPath,
  })
  if ('error' in moved) {
    return {
      kind: 'left',
      reason: `its frames could not be moved: ${describeError(moved.error)}`,
    }
  }
  return moved.spoolRemoved
    ? { kind: 'recovered', framesPath: moved.framesPath }
    : {
        kind: 'left',
        reason: `its frames are kept at ${moved.framesPath}, but this copy could not be removed`,
      }
}

const warnAboutRecovery = (
  log: ServiceLogger,
  recovered: readonly string[],
  left: readonly { readonly path: string; readonly reason: string }[],
): void => {
  const [first] = recovered
  if (first !== undefined) {
    const names = recovered.map((framesPath) => path.basename(framesPath))
    const noun = names.length === 1 ? 'recording' : 'recordings'
    log(
      'warn',
      `${LOG_PREFIX} A worker ended while recording, so the frames of ${names.length.toString()} ${noun} were recovered: ${names.join(', ')}. Each recovered recording stops at its last held image. Convert them with, for example: ${describeConversion(first, `${first.slice(0, -FRAMES_EXTENSION.length)}.webm`)}`,
    )
  }
  if (left.length > 0) {
    log(
      'warn',
      `${LOG_PREFIX} ${left.length.toString()} frame spool${left.length === 1 ? '' : 's'} could not be recovered and stay where they are: ${left.map(({ path: spoolPath, reason }) => `${spoolPath} (${reason})`).join('; ')}`,
    )
  }
}

// Non-recursive: a directory that still holds anything is left as it is.
const removeEmptyDirectories = async (
  {
    log,
    removeDirectory,
  }: Pick<RecoveryDependencies, 'log'> & {
    readonly removeDirectory: (directory: string) => Promise<void>
  },
  runDirectory: string,
  root: string,
): Promise<boolean> => {
  if (!(await removeIfEmpty(removeDirectory, runDirectory))) {
    log(
      'debug',
      `${LOG_PREFIX} Left ${runDirectory} in place: it holds files that are not frame spools.`,
    )
    return false
  }
  await removeIfEmpty(removeDirectory, root)
  return true
}

const removeIfEmpty = async (
  removeDirectory: (directory: string) => Promise<void>,
  directory: string,
): Promise<boolean> => {
  try {
    await removeDirectory(directory)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOTEMPTY' || code === 'EEXIST') {
      return false
    }
    throw error
  }
}
