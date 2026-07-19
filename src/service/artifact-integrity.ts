import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProcessBoundary } from './boundaries.js'
import { nodeProcess } from './boundaries.js'
import { GLOBAL_RECORDING_SLOT_INVALID_STALE_MS } from './constants.js'

const RESERVATION_SUFFIX = '.wdio-reserve'
const ignoreFileError = (): undefined => undefined
const emptyTextOnFileError = (): string => ''

interface ArtifactReservationMetadata {
  createdAt: number
  ownerId?: string
  outputPath: string
  pid: number
  temporaryPath: string
}

export interface AtomicArtifactOptions {
  desiredPath: string
  produce: (temporaryPath: string) => Promise<boolean>
  process?: ProcessBoundary
  validate: (temporaryPath: string) => Promise<boolean>
  warn: (message: string) => void
}

export const reserveArtifactPath = async (
  desiredPath: string,
): Promise<string> => {
  await fs.mkdir(path.dirname(desiredPath), { recursive: true })
  for (let collisionIndex = 1; ; collisionIndex += 1) {
    const candidatePath = getCollisionPath(desiredPath, collisionIndex)
    try {
      const fileHandle = await fs.open(candidatePath, 'wx')
      await fileHandle.close()
      return candidatePath
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }
  }
}

export const publishAtomicArtifact = async (
  options: AtomicArtifactOptions,
): Promise<string | undefined> => {
  const processBoundary = options.process ?? nodeProcess
  const reservation = await acquireArtifactReservation(
    options.desiredPath,
    processBoundary,
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

    if (
      !(await isArtifactReservationOwner(
        reservation.reservationPath,
        reservation.ownerId,
      ))
    ) {
      options.warn(
        `[WdioPuppeteerVideoService] Refusing to publish an artifact after reservation ownership changed: ${reservation.outputPath}`,
      )
      return undefined
    }

    await fs.rename(reservation.temporaryPath, reservation.outputPath)
    published = true
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
    await releaseArtifactReservation(
      reservation.reservationPath,
      reservation.ownerId,
    )
  }
}

const acquireArtifactReservation = async (
  desiredPath: string,
  processBoundary: ProcessBoundary,
): Promise<{
  outputPath: string
  ownerId: string
  reservationPath: string
  temporaryPath: string
}> => {
  await fs.mkdir(path.dirname(desiredPath), { recursive: true })
  for (let collisionIndex = 1; ; collisionIndex += 1) {
    const outputPath = getCollisionPath(desiredPath, collisionIndex)
    if (await pathExists(outputPath)) {
      continue
    }

    const reservationPath = `${outputPath}${RESERVATION_SUFFIX}`
    const temporaryPath = createTemporaryArtifactPath(
      outputPath,
      processBoundary.pid,
    )
    const ownerId = randomUUID()
    let fileHandle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      fileHandle = await fs.open(reservationPath, 'wx')
      const metadata: ArtifactReservationMetadata = {
        createdAt: Date.now(),
        ownerId,
        outputPath,
        pid: processBoundary.pid,
        temporaryPath,
      }
      await fileHandle.writeFile(JSON.stringify(metadata), 'utf8')
      await fileHandle.close()
      fileHandle = undefined
      return { outputPath, ownerId, reservationPath, temporaryPath }
    } catch (error) {
      await fileHandle?.close().catch(() => {
        /* best-effort failed-reservation close */
      })
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        await fs.unlink(reservationPath).catch(() => {
          /* best-effort failed-reservation cleanup */
        })
        throw error
      }

      const removed = await cleanupStaleReservation(
        reservationPath,
        processBoundary,
      )
      if (removed) {
        collisionIndex -= 1
      }
    }
  }
}

const cleanupStaleReservation = async (
  reservationPath: string,
  processBoundary: ProcessBoundary,
): Promise<boolean> => {
  const [contents, stats] = await Promise.all([
    fs.readFile(reservationPath, 'utf8').catch(emptyTextOnFileError),
    fs.stat(reservationPath).catch(ignoreFileError),
  ])
  if (!stats) {
    return true
  }

  const metadata = parseReservationMetadata(contents)
  const reservedOutputPath = reservationPath.slice(
    0,
    -RESERVATION_SUFFIX.length,
  )
  const ownsReservation = metadata?.outputPath === reservedOutputPath
  if (ownsReservation && metadata && processBoundary.isAlive(metadata.pid)) {
    return false
  }
  if (
    !metadata &&
    Date.now() - stats.mtimeMs < GLOBAL_RECORDING_SLOT_INVALID_STALE_MS
  ) {
    return false
  }

  if (
    ownsReservation &&
    metadata &&
    isTemporaryPathForOutput(metadata.temporaryPath, reservedOutputPath)
  ) {
    if (metadata.ownerId) {
      const currentMetadata = await readReservationMetadata(reservationPath)
      if (currentMetadata?.ownerId !== metadata.ownerId) {
        return false
      }
      await fs.unlink(metadata.temporaryPath).catch(() => {
        /* best-effort abandoned temporary-output cleanup */
      })
      return releaseArtifactReservation(reservationPath, metadata.ownerId)
    }
  }

  const [currentContents, currentStats] = await Promise.all([
    fs.readFile(reservationPath, 'utf8').catch(ignoreFileError),
    fs.stat(reservationPath).catch(ignoreFileError),
  ])
  if (
    currentContents !== contents ||
    currentStats?.ino !== stats.ino ||
    currentStats?.mtimeMs !== stats.mtimeMs
  ) {
    return false
  }
  if (
    ownsReservation &&
    metadata &&
    isTemporaryPathForOutput(metadata.temporaryPath, reservedOutputPath)
  ) {
    await fs.unlink(metadata.temporaryPath).catch(() => {
      /* best-effort abandoned legacy temporary-output cleanup */
    })
  }
  await fs.unlink(reservationPath).catch(ignoreFileError)
  return !(await pathExists(reservationPath))
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

const parseReservationMetadata = (
  contents: string,
): ArtifactReservationMetadata | undefined => {
  try {
    const value = JSON.parse(contents) as Partial<ArtifactReservationMetadata>
    if (
      typeof value.createdAt !== 'number' ||
      (value.ownerId !== undefined &&
        (typeof value.ownerId !== 'string' || !value.ownerId)) ||
      typeof value.outputPath !== 'string' ||
      typeof value.pid !== 'number' ||
      typeof value.temporaryPath !== 'string'
    ) {
      return undefined
    }
    return value as ArtifactReservationMetadata
  } catch {
    return undefined
  }
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

const readReservationMetadata = async (
  reservationPath: string,
): Promise<ArtifactReservationMetadata | undefined> => {
  const contents = await fs
    .readFile(reservationPath, 'utf8')
    .catch(ignoreFileError)
  return contents === undefined ? undefined : parseReservationMetadata(contents)
}

const releaseArtifactReservation = async (
  reservationPath: string,
  ownerId: string,
): Promise<boolean> => {
  if (!(await isArtifactReservationOwner(reservationPath, ownerId))) {
    return false
  }
  await fs.unlink(reservationPath).catch(ignoreFileError)
  return !(await pathExists(reservationPath))
}

const isArtifactReservationOwner = async (
  reservationPath: string,
  ownerId: string,
): Promise<boolean> => {
  const metadata = await readReservationMetadata(reservationPath)
  return metadata?.ownerId === ownerId
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
  return fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false)
}
