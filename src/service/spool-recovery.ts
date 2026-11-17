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
import { CLUSTER, SEGMENT, SIMPLE_BLOCK } from './matroska-writer.js'
import { describeError } from './normalization.js'

// The stream header and the first cluster's opening are a few hundred bytes,
// so the first block starts well inside this prefix however large its image.
const SPOOL_PREFIX_BYTES = 16 * 1_024
const SPOOL_EXTENSION = '.mkv'
const LOG_PREFIX = '[WdioPuppeteerVideoService]'

type SpoolContent = 'frames' | 'no-frames'

type ElementHeader =
  | {
      readonly headerLength: number
      readonly id: number
      /** Undefined when the element's size is unknown. */
      readonly size: number | undefined
    }
  | 'invalid'
  | 'truncated'

const readElementId = (
  bytes: Buffer,
  offset: number,
):
  | { readonly id: number; readonly length: number }
  | 'invalid'
  | 'truncated' => {
  const first = bytes[offset]
  if (first === undefined) {
    return 'truncated'
  }
  // The leading zero bits of the first byte give the id's length: 1 to 4.
  const length = Math.clz32(first) - 24 + 1
  if (length > 4) {
    return 'invalid'
  }
  if (offset + length > bytes.length) {
    return 'truncated'
  }
  let id = 0
  for (let index = 0; index < length; index += 1) {
    id = id * 256 + (bytes[offset + index] ?? 0)
  }
  return { id, length }
}

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

const readElementHeader = (bytes: Buffer, offset: number): ElementHeader => {
  const id = readElementId(bytes, offset)
  if (typeof id === 'string') {
    return id
  }
  const size = readElementSize(bytes, offset + id.length)
  if (typeof size === 'string') {
    return size
  }
  return {
    headerLength: id.length + size.length,
    id: id.id,
    size: size.size,
  }
}

/**
 * Whether the start of a spool holds a frame: a `SimpleBlock` inside the
 * first cluster, found by walking the elements the writer produces. Only the
 * prefix is looked at; whatever it cannot settle (a prefix that ends before an
 * answer, an element it does not understand) counts as frames, because the
 * alternative is deleting a recording. `whole` says the prefix is the whole
 * file, so its end is the file's end and no block follows it.
 */
export const classifySpoolPrefix = (
  prefix: Buffer,
  whole: boolean,
): SpoolContent => {
  const unsettled: SpoolContent = whole ? 'no-frames' : 'frames'
  let offset = 0
  while (offset < prefix.length) {
    const header = readElementHeader(prefix, offset)
    if (header === 'truncated') {
      return unsettled
    }
    if (header === 'invalid') {
      return 'frames'
    }
    if (header.id === SIMPLE_BLOCK) {
      return 'frames'
    }
    if (header.id === SEGMENT || header.id === CLUSTER) {
      // Both are written with an unknown size: their children follow.
      offset += header.headerLength
      continue
    }
    if (header.size === undefined) {
      return 'frames'
    }
    offset += header.headerLength + header.size
  }
  return unsettled
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

/** `<slug>_part<N>.<uuid>.mkv` -> `<slug>_part<N>`. */
const spoolBaseName = (fileName: string): string => {
  const withoutExtension = fileName.slice(0, -SPOOL_EXTENSION.length)
  const uuidDot = withoutExtension.lastIndexOf('.')
  return uuidDot > 0 ? withoutExtension.slice(0, uuidDot) : withoutExtension
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
 * A spool with a frame becomes `<outputDir>/<slug>_part<N>.frames.mkv`; one
 * with none is deleted; one that cannot be handled stays, and then so does the
 * directory. Only this run's directory is touched, and only after the same
 * containment check the global-slot cleanup uses. Resolves `undefined` when
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
  for (const spoolPath of spools) {
    const outcome = await recoverSpool(dependencies, spoolPath)
    if (outcome.kind === 'recovered') {
      recovered.push(outcome.framesPath)
    } else if (outcome.kind === 'deleted') {
      deleted.push(spoolPath)
    } else {
      left.push({ path: spoolPath, reason: outcome.reason })
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
  const stats = await fs.lstat(runDirectory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  })
  if (stats === undefined) {
    return undefined
  }
  if (!stats.isDirectory()) {
    // A link could lead anywhere: it is not the directory the workers made.
    throw new TypeError(
      `${LOG_PREFIX} Refusing to recover ${runDirectory}: it is not a plain directory.`,
    )
  }
  return runDirectory
}

// Only regular files ending in `.mkv`, directly in the directory, are spools.
const listSpools = async (runDirectory: string): Promise<string[]> => {
  const entries = await fs.readdir(runDirectory, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(SPOOL_EXTENSION))
    .map((entry) => path.join(runDirectory, entry.name))
    .sort()
}

const recoverSpool = async (
  dependencies: RecoveryDependencies,
  spoolPath: string,
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
      content === 'frames' ? 'moved frame spool' : 'frameless spool',
    )
  if (content === 'no-frames') {
    return (await removeSpool(spoolPath))
      ? { kind: 'deleted' }
      : { kind: 'left', reason: 'it holds no frame but could not be deleted' }
  }
  const moved = await moveSpoolToFramesFile({
    linkFile: dependencies.linkFile,
    plannedPath: path.join(
      dependencies.outputDir,
      `${spoolBaseName(path.basename(spoolPath))}.webm`,
    ),
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
