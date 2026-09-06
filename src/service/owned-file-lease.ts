import { randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import {
  type ClockBoundary,
  type FileStatsBoundary,
  type FileSystemBoundary,
  nodeFileSystem,
  nodeProcess,
  type ProcessBoundary,
  systemClock,
} from './boundaries.js'

export const OWNED_FILE_LEASE_SCHEMA_VERSION = 1 as const

export interface OwnedFileLeaseMetadata<TPayload = unknown> {
  readonly schemaVersion: typeof OWNED_FILE_LEASE_SCHEMA_VERSION
  readonly ownerToken: string
  readonly pid: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly payload?: TPayload
}

export interface ParsedOwnedFileLeaseMetadata {
  readonly createdAt?: number
  readonly format: 'future' | 'v1' | 'legacy'
  readonly ownerToken?: string
  readonly payload?: unknown
  readonly pid: number
  readonly updatedAt?: number
}

export interface OwnedFileLeaseDependencies {
  readonly clock?: ClockBoundary
  readonly fileSystem?: FileSystemBoundary
  readonly process?: ProcessBoundary
  readonly randomId?: () => string
}

export interface TryAcquireOwnedFileLeaseOptions<TPayload> {
  readonly filePath: string
  readonly invalidStaleMs: number
  readonly onReclaimed?: (
    metadata: ParsedOwnedFileLeaseMetadata | undefined,
  ) => Promise<void>
  readonly payload?: TPayload
}

interface FileIdentity {
  readonly birthtimeMs?: number
  readonly dev?: number
  readonly ino?: number
  readonly mtimeMs: number
  readonly size?: number
}

const ignoreFileError = (): undefined => undefined
const isMissingFileError = (error: unknown): boolean => {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export class OwnedFileLeaseOperationalError extends Error {
  readonly filePath: string
  readonly operation: string

  constructor(filePath: string, operation: string, cause?: unknown) {
    super(
      `[WdioPuppeteerVideoService] Failed to ${operation} for owned-file lease ${filePath}.`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'OwnedFileLeaseOperationalError'
    this.filePath = filePath
    this.operation = operation
  }
}

/**
 * Distinguishes a momentary filesystem refusal from a real fault. Antivirus
 * scanners, indexers, and descriptor shortages hold a lease file open for a
 * moment; callers that already poll should treat that as contention instead of
 * failing on the first attempt. Windows reports a sharing violation as `EPERM`,
 * which is a permanent condition everywhere else.
 */
export const isTransientLeaseFileError = (
  error: unknown,
  platform: NodeJS.Platform,
): boolean => {
  const cause =
    error instanceof OwnedFileLeaseOperationalError ? error.cause : error
  if (!(cause instanceof Error)) {
    return false
  }
  const code = (cause as NodeJS.ErrnoException).code
  return (
    code === 'EBUSY' ||
    code === 'EAGAIN' ||
    code === 'EMFILE' ||
    code === 'ENFILE' ||
    (platform === 'win32' && code === 'EPERM')
  )
}

export class OwnedFileLease {
  readonly createdAt: number
  readonly filePath: string
  readonly ownerToken: string
  readonly pid: number
  private readonly fileHandle: FileHandle
  private readonly fileIdentity: FileIdentity
  private readonly fileSystem: FileSystemBoundary
  private releaseTask: Promise<boolean> | undefined
  private released = false

  constructor(options: {
    createdAt: number
    fileHandle: FileHandle
    fileIdentity: FileIdentity
    filePath: string
    fileSystem: FileSystemBoundary
    ownerToken: string
    pid: number
  }) {
    this.createdAt = options.createdAt
    this.fileHandle = options.fileHandle
    this.fileIdentity = options.fileIdentity
    this.filePath = options.filePath
    this.fileSystem = options.fileSystem
    this.ownerToken = options.ownerToken
    this.pid = options.pid
  }

  async isOwner(): Promise<boolean> {
    return !this.released && (await this.matchesCurrentFile())
  }

  release(): Promise<boolean> {
    this.releaseTask ??= this.releaseNow()
    return this.releaseTask
  }

  private async releaseNow(): Promise<boolean> {
    const ownedBeforeClose = await this.matchesCurrentFile().catch(() => false)
    this.released = true
    await this.fileHandle.close().catch(ignoreFileError)
    if (
      !ownedBeforeClose ||
      !(await this.matchesCurrentFile().catch(() => false))
    ) {
      return false
    }

    try {
      await this.fileSystem.unlink(this.filePath)
    } catch {
      return false
    }
    return !(await this.fileSystem.stat(this.filePath).catch(ignoreFileError))
  }

  private async matchesCurrentFile(): Promise<boolean> {
    const snapshot = await readLeaseSnapshot(this.filePath, this.fileSystem)
    if (!snapshot) {
      return false
    }

    const metadata = parseOwnedFileLeaseMetadata(snapshot.contents)
    return (
      metadata?.format === 'v1' &&
      metadata.ownerToken === this.ownerToken &&
      isSameFile(this.fileIdentity, snapshot.stats)
    )
  }
}

export const tryAcquireOwnedFileLease = async <TPayload>(
  options: TryAcquireOwnedFileLeaseOptions<TPayload>,
  dependencies: OwnedFileLeaseDependencies = {},
): Promise<OwnedFileLease | undefined> => {
  const clock = dependencies.clock ?? systemClock
  const fileSystem = dependencies.fileSystem ?? nodeFileSystem
  const processBoundary = dependencies.process ?? nodeProcess
  const randomId = dependencies.randomId ?? randomUUID

  const fileHandle = await openLeaseCandidate(options, dependencies, fileSystem)
  if (!fileHandle) {
    return undefined
  }

  let candidateIdentity: FileIdentity
  try {
    candidateIdentity = await readFileHandleIdentity(fileHandle)
  } catch (error) {
    await fileHandle.close().catch(ignoreFileError)
    throw new OwnedFileLeaseOperationalError(
      options.filePath,
      'inspect the exclusive lease candidate',
      error,
    )
  }

  const createdAt = clock.now()
  const ownerToken = randomId()
  const metadata = createLeaseMetadata({
    createdAt,
    ownerToken,
    payload: options.payload,
    pid: processBoundary.pid,
    updatedAt: createdAt,
  })
  try {
    await writeLeaseMetadata(fileHandle, metadata)
  } catch (error) {
    await discardLeaseCandidate(
      options.filePath,
      fileHandle,
      candidateIdentity,
      fileSystem,
    )
    throw new OwnedFileLeaseOperationalError(
      options.filePath,
      'write ownership metadata',
      error,
    )
  }

  let fileIdentity: FileIdentity
  try {
    fileIdentity = await readFileHandleIdentity(fileHandle)
  } catch (error) {
    await discardLeaseCandidate(
      options.filePath,
      fileHandle,
      candidateIdentity,
      fileSystem,
    )
    throw new OwnedFileLeaseOperationalError(
      options.filePath,
      'verify written ownership metadata',
      error,
    )
  }

  const lease = new OwnedFileLease({
    createdAt,
    fileHandle,
    fileIdentity,
    filePath: options.filePath,
    fileSystem,
    ownerToken,
    pid: processBoundary.pid,
  })
  let owned: boolean
  try {
    owned = await lease.isOwner()
  } catch (error) {
    await lease.release()
    throw error
  }
  if (!owned) {
    await lease.release()
    return undefined
  }
  return lease
}

const openLeaseCandidate = async (
  options: Pick<
    TryAcquireOwnedFileLeaseOptions<unknown>,
    'filePath' | 'invalidStaleMs' | 'onReclaimed'
  >,
  dependencies: OwnedFileLeaseDependencies,
  fileSystem: FileSystemBoundary,
): Promise<FileHandle | undefined> => {
  const candidate = await openLeaseCandidateOnce(options.filePath, fileSystem)
  if (candidate) {
    return candidate
  }
  if (!(await cleanupStaleOwnedFileLease(options, dependencies))) {
    return undefined
  }
  // A peer can win after reclamation. Yield to the caller's contention policy.
  return openLeaseCandidateOnce(options.filePath, fileSystem)
}

const openLeaseCandidateOnce = async (
  filePath: string,
  fileSystem: FileSystemBoundary,
): Promise<FileHandle | undefined> => {
  try {
    return await fileSystem.openExclusive(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return undefined
    }
    throw new OwnedFileLeaseOperationalError(
      filePath,
      'open an exclusive candidate',
      error,
    )
  }
}

const readLeaseSnapshot = async (
  filePath: string,
  fileSystem: FileSystemBoundary,
): Promise<{ contents: string; stats: FileStatsBoundary } | undefined> => {
  const [contents, stats] = await Promise.allSettled([
    fileSystem.readText(filePath),
    fileSystem.stat(filePath),
  ])
  for (const result of [contents, stats]) {
    if (result.status === 'rejected' && !isMissingFileError(result.reason)) {
      throw new OwnedFileLeaseOperationalError(
        filePath,
        'inspect existing lease metadata',
        result.reason,
      )
    }
  }
  if (contents.status === 'rejected' || stats.status === 'rejected') {
    return undefined
  }
  return { contents: contents.value, stats: stats.value }
}

export const cleanupStaleOwnedFileLease = async (
  options: {
    readonly filePath: string
    readonly invalidStaleMs: number
    readonly onReclaimed?: (
      metadata: ParsedOwnedFileLeaseMetadata | undefined,
    ) => Promise<void>
  },
  dependencies: OwnedFileLeaseDependencies = {},
): Promise<boolean> => {
  const clock = dependencies.clock ?? systemClock
  const fileSystem = dependencies.fileSystem ?? nodeFileSystem
  const processBoundary = dependencies.process ?? nodeProcess
  const snapshot = await readLeaseSnapshot(options.filePath, fileSystem)
  if (!snapshot) {
    return true
  }
  const { contents, stats } = snapshot

  const metadata = parseOwnedFileLeaseMetadata(contents)
  if (metadata && processBoundary.isAlive(metadata.pid)) {
    return false
  }
  if (!metadata && clock.now() - stats.mtimeMs < options.invalidStaleMs) {
    return false
  }

  const current = await readLeaseSnapshot(options.filePath, fileSystem)
  if (!current) {
    return true
  }
  if (current.contents !== contents || !isSameFile(stats, current.stats)) {
    return false
  }

  try {
    await fileSystem.unlink(options.filePath)
  } catch (error) {
    if (isMissingFileError(error)) {
      return true
    }
    throw new OwnedFileLeaseOperationalError(
      options.filePath,
      'remove a reclaimable lease',
      error,
    )
  }
  await options.onReclaimed?.(metadata)
  return true
}

export const parseOwnedFileLeaseMetadata = (
  contents: string,
): ParsedOwnedFileLeaseMetadata | undefined => {
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch {
    return undefined
  }
  if (!isRecord(value)) {
    return undefined
  }

  if (value.schemaVersion !== undefined) {
    if (value.schemaVersion !== OWNED_FILE_LEASE_SCHEMA_VERSION) {
      return parseFutureLeaseMetadata(value)
    }
    if (
      !isNonEmptyString(value.ownerToken) ||
      !isPositiveInteger(value.pid) ||
      !isFiniteTimestamp(value.createdAt) ||
      !isFiniteTimestamp(value.updatedAt)
    ) {
      return undefined
    }
    return {
      createdAt: value.createdAt,
      format: 'v1',
      ownerToken: value.ownerToken,
      ...(value.payload === undefined ? {} : { payload: value.payload }),
      pid: value.pid,
      updatedAt: value.updatedAt,
    }
  }

  if (!isPositiveInteger(value.pid)) {
    return undefined
  }
  const ownerToken = isNonEmptyString(value.ownerId) ? value.ownerId : undefined
  const createdAt = firstTimestamp(value.createdAt, value.startedAt)
  const updatedAt = firstTimestamp(
    value.updatedAt,
    value.lastUpdatedAt,
    createdAt,
  )
  return {
    ...(createdAt === undefined ? {} : { createdAt }),
    format: 'legacy',
    ...(ownerToken === undefined ? {} : { ownerToken }),
    payload: value,
    pid: value.pid,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

const parseFutureLeaseMetadata = (
  value: Record<string, unknown>,
): ParsedOwnedFileLeaseMetadata | undefined => {
  // Preserve live owners even when this version cannot validate their schema.
  if (!isPositiveInteger(value.pid)) {
    return undefined
  }
  return {
    format: 'future',
    ...(isNonEmptyString(value.ownerToken)
      ? { ownerToken: value.ownerToken }
      : {}),
    payload: value,
    pid: value.pid,
  }
}

const createLeaseMetadata = <TPayload>(options: {
  createdAt: number
  ownerToken: string
  payload: TPayload | undefined
  pid: number
  updatedAt: number
}): OwnedFileLeaseMetadata<TPayload> => ({
  schemaVersion: OWNED_FILE_LEASE_SCHEMA_VERSION,
  ownerToken: options.ownerToken,
  pid: options.pid,
  createdAt: options.createdAt,
  updatedAt: options.updatedAt,
  ...(options.payload === undefined ? {} : { payload: options.payload }),
})

const writeLeaseMetadata = async (
  fileHandle: FileHandle,
  metadata: OwnedFileLeaseMetadata,
): Promise<void> => {
  const bytes = Buffer.from(JSON.stringify(metadata), 'utf8')
  await fileHandle.truncate(0)
  let offset = 0
  while (offset < bytes.length) {
    const result = await fileHandle.write(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    )
    if (result.bytesWritten <= 0) {
      throw new Error('The lease metadata write made no forward progress.')
    }
    offset += result.bytesWritten
  }
}

const readFileHandleIdentity = async (
  fileHandle: FileHandle,
): Promise<FileIdentity> => {
  const stats = await fileHandle.stat()
  return {
    birthtimeMs: stats.birthtimeMs,
    dev: stats.dev,
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  }
}

const discardLeaseCandidate = async (
  filePath: string,
  fileHandle: FileHandle,
  identity: FileIdentity,
  fileSystem: FileSystemBoundary,
): Promise<void> => {
  await fileHandle.close().catch(ignoreFileError)
  const currentStats = await fileSystem.stat(filePath).catch(ignoreFileError)
  if (!currentStats || !isSameFile(identity, currentStats)) {
    return
  }
  await fileSystem.unlink(filePath).catch(ignoreFileError)
}

const isSameFile = (
  expected: FileIdentity | FileStatsBoundary,
  current: FileIdentity | FileStatsBoundary,
): boolean => {
  if (
    expected.dev !== undefined &&
    current.dev !== undefined &&
    expected.ino !== undefined &&
    current.ino !== undefined
  ) {
    return expected.dev === current.dev && expected.ino === current.ino
  }
  if (expected.birthtimeMs !== undefined && current.birthtimeMs !== undefined) {
    return expected.birthtimeMs === current.birthtimeMs
  }
  return (
    expected.mtimeMs === current.mtimeMs &&
    (expected.size === undefined ||
      current.size === undefined ||
      expected.size === current.size)
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.trim().length > 0
}

const isPositiveInteger = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

const isFiniteTimestamp = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

const firstTimestamp = (...values: unknown[]): number | undefined => {
  return values.find(isFiniteTimestamp) as number | undefined
}
