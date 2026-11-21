import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveGlobalRecordingLockDir } from './retry-state.js'

const POST_PROCESS_DIRECTORY_NAME = 'post-process'
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u

export interface GlobalSlotRunDirectories {
  readonly recording: string
  readonly postProcess: string
  readonly root: string
  readonly run: string
}

export interface GlobalSlotRunDirectoryOptions {
  readonly lockDir?: string
  readonly outputDir?: string
  readonly runId: string
}

export const isSafeGlobalSlotRunId = (runId: string): boolean => {
  return RUN_ID_PATTERN.test(runId)
}

/** Whether `directory` is, once resolved, a direct child of `root`. */
export const isDirectChildDirectory = (
  root: string,
  directory: string,
): boolean => path.dirname(path.resolve(directory)) === path.resolve(root)

/**
 * Whether each directory, in order, is present as a plain directory: `false`
 * at the first that is missing. One that is a link, a junction or a file is
 * refused with a `TypeError`, since a link could lead anywhere; `refusal`
 * describes the refused operation for the message.
 */
export const arePlainDirectories = async (
  directories: readonly string[],
  refusal: (directory: string) => string,
): Promise<boolean> => {
  for (const directory of directories) {
    const stats = await lstatIfPresent(directory)
    if (stats === undefined) {
      return false
    }
    if (!stats.isDirectory()) {
      throw new TypeError(`${refusal(directory)}: it is not a plain directory.`)
    }
  }
  return true
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

export const resolveGlobalSlotRunDirectories = (
  options: GlobalSlotRunDirectoryOptions,
): GlobalSlotRunDirectories => {
  if (!isSafeGlobalSlotRunId(options.runId)) {
    throw new TypeError(
      '[WdioPuppeteerVideoService] The launcher run ID is unsafe for global-slot path construction.',
    )
  }

  const root = resolveGlobalRecordingLockDir(options.outputDir, options.lockDir)
  const run = path.join(root, options.runId)
  return {
    recording: run,
    postProcess: path.join(run, POST_PROCESS_DIRECTORY_NAME),
    root,
    run,
  }
}

export const cleanupGlobalSlotRunDirectory = async (
  options: GlobalSlotRunDirectoryOptions,
): Promise<void> => {
  const directories = resolveGlobalSlotRunDirectories(options)
  if (!isDirectChildDirectory(directories.root, directories.run)) {
    throw new TypeError(
      '[WdioPuppeteerVideoService] Refusing to clean a global-slot path outside its configured root.',
    )
  }
  await fs.rm(path.resolve(directories.run), { force: true, recursive: true })
}
