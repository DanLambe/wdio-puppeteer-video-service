import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  MANIFEST_SCHEMA_VERSION,
  type ManifestRunV1,
  type VideoManifestV1,
  validateVideoManifest,
} from '../manifest.js'
import { nodeProcess, systemClock } from './boundaries.js'
import type { ManifestRunContext } from './manifest-context.js'
import {
  getManifestRunDirectory,
  MANIFEST_WORK_DIRECTORY,
} from './manifest-journal.js'
import {
  isTransientLeaseFileError,
  type OwnedFileLease,
  tryAcquireOwnedFileLease,
} from './owned-file-lease.js'

const MANIFEST_FILE_NAME = 'manifest.json'
const MANIFEST_LOCK_FILE_NAME = '.wdio-video-manifest.lock'
const MANIFEST_LOCK_TIMEOUT_MS = 30_000
const MANIFEST_LOCK_STALE_MS = 120_000
const MANIFEST_LOCK_POLL_MS = 25
const ignoreFileError = (): undefined => undefined

export const persistManifestRun = async (
  context: ManifestRunContext,
  run: ManifestRunV1,
  generatedAt: string,
): Promise<VideoManifestV1> => {
  const release = await acquireManifestLock(context.outputDir)
  let temporaryPath: string | undefined
  try {
    const manifestPath = path.join(context.outputDir, MANIFEST_FILE_NAME)
    const existing = await readExistingManifest(manifestPath)
    const manifest: VideoManifestV1 = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      generatedAt,
      runs: [
        ...existing.runs.filter((existingRun) => existingRun.id !== run.id),
        run,
      ],
    }
    temporaryPath = path.join(
      context.outputDir,
      `.manifest-${process.pid.toString()}-${randomUUID()}.tmp`,
    )
    await fs.mkdir(context.outputDir, { recursive: true })
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(manifest, undefined, 2)}\n`,
      'utf8',
    )
    await fs.rename(temporaryPath, manifestPath)
    temporaryPath = undefined
    await cleanupManifestRun(context)
    return manifest
  } finally {
    if (temporaryPath) {
      await fs.unlink(temporaryPath).catch(ignoreFileError)
    }
    await release()
  }
}

const cleanupManifestRun = async (
  context: ManifestRunContext,
): Promise<void> => {
  await fs.rm(getManifestRunDirectory(context), {
    recursive: true,
    force: true,
  })
  await fs
    .rmdir(path.join(context.outputDir, MANIFEST_WORK_DIRECTORY))
    .catch(ignoreFileError)
}

const readExistingManifest = async (
  manifestPath: string,
): Promise<VideoManifestV1> => {
  const value = await fs
    .readFile(manifestPath, 'utf8')
    .then((content) => JSON.parse(content) as unknown)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return undefined
      }
      throw error
    })
  if (value === undefined) {
    return {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      generatedAt: new Date(0).toISOString(),
      runs: [],
    }
  }
  const validation = validateVideoManifest(value)
  if (!validation.valid) {
    throw new Error(
      `Existing manifest.json is invalid: ${validation.errors.join('; ')}`,
    )
  }
  return value as VideoManifestV1
}

const acquireManifestLock = async (
  outputDir: string,
): Promise<() => Promise<void>> => {
  await fs.mkdir(outputDir, { recursive: true })
  const lockPath = path.join(outputDir, MANIFEST_LOCK_FILE_NAME)
  const deadline = systemClock.now() + MANIFEST_LOCK_TIMEOUT_MS
  let transientFailure: unknown
  while (systemClock.now() < deadline) {
    let lease: OwnedFileLease | undefined
    try {
      lease = await tryAcquireOwnedFileLease({
        filePath: lockPath,
        invalidStaleMs: MANIFEST_LOCK_STALE_MS,
        payload: { resource: 'manifest-aggregation' },
      })
      transientFailure = undefined
    } catch (error) {
      // A sharing violation or descriptor shortage is contention, not a fault.
      // Losing the whole run's manifest and report to one of them would be a
      // far worse outcome than waiting out the existing deadline.
      if (!isTransientLeaseFileError(error, nodeProcess.platform)) {
        throw error
      }
      transientFailure = error
    }
    if (lease) {
      const acquired = lease
      return async () => {
        await acquired.release()
      }
    }
    await systemClock.delay(MANIFEST_LOCK_POLL_MS)
  }
  if (transientFailure !== undefined) {
    throw new Error(
      `Timed out waiting for manifest lock after repeated transient filesystem failures: ${lockPath}`,
      { cause: transientFailure },
    )
  }
  throw new Error(`Timed out waiting for manifest lock: ${lockPath}`)
}
