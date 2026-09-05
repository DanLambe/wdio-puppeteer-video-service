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
  const resolvedRoot = path.resolve(directories.root)
  const resolvedRun = path.resolve(directories.run)
  if (path.dirname(resolvedRun) !== resolvedRoot) {
    throw new TypeError(
      '[WdioPuppeteerVideoService] Refusing to clean a global-slot path outside its configured root.',
    )
  }
  await fs.rm(resolvedRun, { force: true, recursive: true })
}
