import type { ClockBoundary, FileSystemBoundary } from './boundaries.js'
import {
  RECORDING_UNLINK_ATTEMPTS,
  RECORDING_UNLINK_RETRY_MS,
} from './constants.js'
import type { ServiceLogger } from './logging.js'
import { describeError } from './normalization.js'

export interface FileRemovalDependencies {
  readonly clock: ClockBoundary
  readonly fileSystem: Pick<FileSystemBoundary, 'unlink'>
  readonly log: ServiceLogger
}

/**
 * Removes a file the worker created. On Windows, a file a process has just
 * closed can stay locked for a moment, so a lock is retried briefly; any other
 * failure, or a lock that outlasts the retries, leaves the file and says so.
 * Resolves whether the file is gone.
 */
export const removeFileWithRetry = async (
  dependencies: FileRemovalDependencies,
  filePath: string,
  description: string,
): Promise<boolean> => {
  // Every attempt either returns or waits for the next; the last one returns.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await dependencies.fileSystem.unlink(filePath)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return true
      }
      if (!isFileLockedError(code) || attempt === RECORDING_UNLINK_ATTEMPTS) {
        dependencies.log(
          'warn',
          `[WdioPuppeteerVideoService] Could not remove the ${description} ${filePath}: ${describeError(error)}`,
        )
        return false
      }
    }
    await dependencies.clock.delay(RECORDING_UNLINK_RETRY_MS)
  }
}

const isFileLockedError = (code: string | undefined): boolean =>
  code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
