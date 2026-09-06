import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  type ClockBoundary,
  nodeProcess,
  type ProcessBoundary,
  systemClock,
} from './boundaries.js'
import { GLOBAL_RECORDING_SLOT_INVALID_STALE_MS } from './constants.js'
import {
  isTransientLeaseFileError,
  type OwnedFileLease,
  type ParsedOwnedFileLeaseMetadata,
  tryAcquireOwnedFileLease,
} from './owned-file-lease.js'

const RESERVATION_SUFFIX = '.wdio-reserve'
const RESERVATION_RETRY_TIMEOUT_MS = 2_000
const RESERVATION_RETRY_POLL_MS = 25
const ignoreFileError = (): undefined => undefined
export const ARTIFACT_PATH_CANDIDATE_LIMIT = 1_000

export class ArtifactPathExhaustedError extends Error {
  readonly candidateLimit: number
  readonly desiredPath: string

  constructor(desiredPath: string) {
    super(
      `[WdioPuppeteerVideoService] Could not reserve an artifact path after ${ARTIFACT_PATH_CANDIDATE_LIMIT.toString()} candidates: ${desiredPath}`,
    )
    this.name = 'ArtifactPathExhaustedError'
    this.candidateLimit = ARTIFACT_PATH_CANDIDATE_LIMIT
    this.desiredPath = desiredPath
  }
}

interface ArtifactLeasePayload {
  outputPath: string
  temporaryPath?: string
}

interface ArtifactReservation {
  lease: OwnedFileLease
  outputPath: string
  temporaryPath: string
}

export interface AtomicArtifactOptions {
  clock?: ClockBoundary
  desiredPath: string
  produce: (temporaryPath: string) => Promise<boolean>
  process?: ProcessBoundary
  validate: (temporaryPath: string) => Promise<boolean>
  warn: (message: string) => void
}

export interface ArtifactReservationDependencies {
  readonly clock?: ClockBoundary
}

export const reserveArtifactPath = async (
  desiredPath: string,
  dependencies: ArtifactReservationDependencies = {},
): Promise<string> => {
  const clock = dependencies.clock ?? systemClock
  await fs.mkdir(path.dirname(desiredPath), { recursive: true })
  for (
    let collisionIndex = 1;
    collisionIndex <= ARTIFACT_PATH_CANDIDATE_LIMIT;
    collisionIndex += 1
  ) {
    const candidatePath = getCollisionPath(desiredPath, collisionIndex)
    if (await pathExists(candidatePath)) {
      continue
    }

    const lease = await acquireArtifactLease(
      `${candidatePath}${RESERVATION_SUFFIX}`,
      { outputPath: candidatePath },
      nodeProcess,
      clock,
    )
    if (!lease) {
      continue
    }
    try {
      const fileHandle = await fs.open(candidatePath, 'wx')
      await fileHandle.close()
      return candidatePath
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    } finally {
      await lease.release()
    }
  }
  throw new ArtifactPathExhaustedError(desiredPath)
}

export const publishAtomicArtifact = async (
  options: AtomicArtifactOptions,
): Promise<string | undefined> => {
  const processBoundary = options.process ?? nodeProcess
  const reservation = await acquireArtifactReservation(
    options.desiredPath,
    processBoundary,
    options.clock ?? systemClock,
  ).catch((error: unknown) => {
    options.warn(
      `[WdioPuppeteerVideoService] Failed to reserve artifact ${options.desiredPath}: ${String(error)}`,
    )
    return undefined
  })
  if (!reservation) {
    return undefined
  }

  let published = false
  try {
    const produced = await options.produce(reservation.temporaryPath)
    if (!produced) {
      return undefined
    }

    const size = await fs
      .stat(reservation.temporaryPath)
      .then((stats) => stats.size)
      .catch(() => 0)
    if (size <= 0) {
      options.warn(
        `[WdioPuppeteerVideoService] Refusing to publish an empty artifact: ${reservation.temporaryPath}`,
      )
      return undefined
    }

    const valid = await options.validate(reservation.temporaryPath)
    if (!valid) {
      options.warn(
        `[WdioPuppeteerVideoService] Refusing to publish a corrupt artifact: ${reservation.temporaryPath}`,
      )
      return undefined
    }

    if (!(await reservation.lease.isOwner())) {
      options.warn(
        `[WdioPuppeteerVideoService] Refusing to publish an artifact after reservation ownership changed: ${reservation.outputPath}`,
      )
      return undefined
    }

    await linkArtifact(reservation.temporaryPath, reservation.outputPath)
    published = true
    await fs.unlink(reservation.temporaryPath).catch((error: unknown) => {
      options.warn(
        `[WdioPuppeteerVideoService] Published artifact but could not remove its temporary link ${reservation.temporaryPath}: ${String(error)}`,
      )
    })
    return reservation.outputPath
  } catch (error) {
    options.warn(
      `[WdioPuppeteerVideoService] Failed to publish artifact ${reservation.outputPath}: ${String(error)}`,
    )
    return undefined
  } finally {
    if (!published) {
      await fs.unlink(reservation.temporaryPath).catch(() => {
        /* best-effort partial-output cleanup */
      })
    }
    await reservation.lease.release()
  }
}

const linkArtifact = async (
  temporaryPath: string,
  outputPath: string,
): Promise<void> => {
  try {
    await fs.link(temporaryPath, outputPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (
      code &&
      ['EPERM', 'EACCES', 'EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(
        code,
      )
    ) {
      throw new Error(
        `Hard-link publication failed (${code}). Use a writable outputDir on a filesystem that supports hard links; no overwrite fallback is used. ${String(error)}`,
        { cause: error },
      )
    }
    throw error
  }
}

const acquireArtifactReservation = async (
  desiredPath: string,
  processBoundary: ProcessBoundary,
  clock: ClockBoundary,
): Promise<ArtifactReservation> => {
  await fs.mkdir(path.dirname(desiredPath), { recursive: true })
  for (
    let collisionIndex = 1;
    collisionIndex <= ARTIFACT_PATH_CANDIDATE_LIMIT;
    collisionIndex += 1
  ) {
    const outputPath = getCollisionPath(desiredPath, collisionIndex)
    if (await pathExists(outputPath)) {
      continue
    }

    const reservationPath = `${outputPath}${RESERVATION_SUFFIX}`
    const temporaryPath = createTemporaryArtifactPath(
      outputPath,
      processBoundary.pid,
    )
    const lease = await acquireArtifactLease(
      reservationPath,
      { outputPath, temporaryPath },
      processBoundary,
      clock,
    )
    if (!lease) {
      continue
    }
    // The output can appear after the initial existence check but before this
    // reservation is acquired. Recheck while the lease is held so the caller
    // never replaces an artifact published by another worker.
    let outputExists: boolean
    try {
      outputExists = await pathExists(outputPath)
    } catch (error) {
      await lease.release()
      throw error
    }
    if (outputExists) {
      await lease.release()
      continue
    }

    return { lease, outputPath, temporaryPath }
  }
  throw new ArtifactPathExhaustedError(desiredPath)
}

const isTemporaryPathForOutput = (
  temporaryPath: string,
  outputPath: string,
): boolean => {
  const temporary = path.parse(temporaryPath)
  const output = path.parse(outputPath)
  return (
    temporary.dir === output.dir &&
    temporary.ext === output.ext &&
    temporary.name.startsWith(`.${output.name}.wdio-`)
  )
}

const createTemporaryArtifactPath = (
  outputPath: string,
  processId: number,
): string => {
  const parsed = path.parse(outputPath)
  return path.join(
    parsed.dir,
    `.${parsed.name}.wdio-${processId.toString()}-${randomUUID()}${parsed.ext}`,
  )
}

const acquireArtifactLease = async (
  reservationPath: string,
  payload: ArtifactLeasePayload,
  processBoundary: ProcessBoundary,
  clock: ClockBoundary,
): Promise<OwnedFileLease | undefined> => {
  const deadline = clock.now() + RESERVATION_RETRY_TIMEOUT_MS
  let transientFailure: unknown
  while (clock.now() < deadline) {
    try {
      return await tryAcquireOwnedFileLease(
        {
          filePath: reservationPath,
          invalidStaleMs: GLOBAL_RECORDING_SLOT_INVALID_STALE_MS,
          onReclaimed: async (metadata) => {
            await cleanupAbandonedArtifact(metadata, payload.outputPath)
          },
          payload,
        },
        { process: processBoundary },
      )
    } catch (error) {
      // A sharing violation or descriptor shortage is not a name collision, so
      // another candidate would hit it too. Wait on this one instead of
      // spending the collision budget, and keep the fault if it never clears.
      if (!isTransientLeaseFileError(error, processBoundary.platform)) {
        throw error
      }
      transientFailure = error
    }
    await clock.delay(RESERVATION_RETRY_POLL_MS)
  }
  throw new Error(
    `Timed out reserving an artifact path after repeated transient filesystem failures: ${reservationPath}`,
    { cause: transientFailure },
  )
}

const cleanupAbandonedArtifact = async (
  metadata: ParsedOwnedFileLeaseMetadata | undefined,
  expectedOutputPath: string,
): Promise<void> => {
  const payload = parseArtifactLeasePayload(metadata?.payload)
  if (
    !payload?.temporaryPath ||
    payload.outputPath !== expectedOutputPath ||
    !isTemporaryPathForOutput(payload.temporaryPath, payload.outputPath)
  ) {
    return
  }
  await fs.unlink(payload.temporaryPath).catch(ignoreFileError)
}

const parseArtifactLeasePayload = (
  value: unknown,
): ArtifactLeasePayload | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const payload = value as Record<string, unknown>
  if (typeof payload.outputPath !== 'string') {
    return undefined
  }
  if (
    payload.temporaryPath !== undefined &&
    typeof payload.temporaryPath !== 'string'
  ) {
    return undefined
  }
  return {
    outputPath: payload.outputPath,
    ...(payload.temporaryPath === undefined
      ? {}
      : { temporaryPath: payload.temporaryPath }),
  }
}

const getCollisionPath = (
  desiredPath: string,
  collisionIndex: number,
): string => {
  if (collisionIndex === 1) {
    return desiredPath
  }

  const parsed = path.parse(desiredPath)
  const partMatch = /^(.*)(_part\d+)$/.exec(parsed.name)
  const baseName = partMatch?.[1] ?? parsed.name
  const partSuffix = partMatch?.[2] ?? ''
  return path.join(
    parsed.dir,
    `${baseName}_run${collisionIndex.toString()}${partSuffix}${parsed.ext}`,
  )
}

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.stat(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}
