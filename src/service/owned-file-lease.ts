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
  readonly format: 'v1' | 'legacy'
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
  readonly heartbeatIntervalMs?: number
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
const RETRY_LEASE_CANDIDATE = Symbol('retry-lease-candidate')

export class OwnedFileLease<TPayload = unknown> {
  readonly createdAt: number
  readonly filePath: string
  readonly ownerToken: string
  readonly pid: number
  private readonly clock: ClockBoundary
  private readonly fileHandle: FileHandle
  private readonly fileIdentity: FileIdentity
  private readonly fileSystem: FileSystemBoundary
  private readonly payload: TPayload | undefined
  private heartbeatTimer: NodeJS.Timeout | undefined
  private refreshTask: Promise<boolean> | undefined
  private releaseTask: Promise<boolean> | undefined
  private released = false

  constructor(options: {
    clock: ClockBoundary
    createdAt: number
    fileHandle: FileHandle
    fileIdentity: FileIdentity
    filePath: string
    fileSystem: FileSystemBoundary
    ownerToken: string
    payload: TPayload | undefined
    pid: number
  }) {
    this.clock = options.clock
    this.createdAt = options.createdAt
    this.fileHandle = options.fileHandle
    this.fileIdentity = options.fileIdentity
    this.filePath = options.filePath
    this.fileSystem = options.fileSystem
    this.ownerToken = options.ownerToken
    this.payload = options.payload
    this.pid = options.pid
  }

  get active(): boolean {
    return !this.released
  }

  startHeartbeat(intervalMs: number | undefined): void {
    if (
      this.released ||
      this.heartbeatTimer ||
      intervalMs === undefined ||
      intervalMs <= 0
    ) {
      return
    }

    this.heartbeatTimer = this.clock.setInterval(() => {
      void this.refresh()
    }, intervalMs)
    this.heartbeatTimer.unref?.()
  }

  async isOwner(): Promise<boolean> {
    return !this.released && (await this.matchesCurrentFile())
  }

  refresh(): Promise<boolean> {
    if (this.released) {
      return Promise.resolve(false)
    }
    if (this.refreshTask) {
      return this.refreshTask
    }

    const refreshTask = this.refreshNow()
    this.refreshTask = refreshTask
    return refreshTask.finally(() => {
      if (this.refreshTask === refreshTask) {
        this.refreshTask = undefined
      }
    })
  }

  release(): Promise<boolean> {
    this.releaseTask ??= this.releaseNow()
    return this.releaseTask
  }

  private async refreshNow(): Promise<boolean> {
    if (this.released || !(await this.matchesCurrentFile())) {
      return false
    }

    const written = await writeLeaseMetadata(
      this.fileHandle,
      createLeaseMetadata({
        createdAt: this.createdAt,
        ownerToken: this.ownerToken,
        payload: this.payload,
        pid: this.pid,
        updatedAt: this.clock.now(),
      }),
    )
    return written && (await this.matchesCurrentFile())
  }

  private async releaseNow(): Promise<boolean> {
    this.stopHeartbeat()
    await this.refreshTask?.catch(() => false)
    const ownedBeforeClose = await this.matchesCurrentFile()
    this.released = true
    await this.fileHandle.close().catch(ignoreFileError)
    if (!ownedBeforeClose || !(await this.matchesCurrentFile())) {
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
    const [contents, stats] = await Promise.all([
      this.fileSystem.readText(this.filePath).catch(ignoreFileError),
      this.fileSystem.stat(this.filePath).catch(ignoreFileError),
    ])
    if (contents === undefined || !stats) {
      return false
    }

    const metadata = parseOwnedFileLeaseMetadata(contents)
    return (
      metadata?.format === 'v1' &&
      metadata.ownerToken === this.ownerToken &&
      isSameFile(this.fileIdentity, stats)
    )
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return
    }
    this.clock.clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }
}

export const tryAcquireOwnedFileLease = async <TPayload>(
  options: TryAcquireOwnedFileLeaseOptions<TPayload>,
  dependencies: OwnedFileLeaseDependencies = {},
): Promise<OwnedFileLease<TPayload> | undefined> => {
  const clock = dependencies.clock ?? systemClock
  const fileSystem = dependencies.fileSystem ?? nodeFileSystem
  const processBoundary = dependencies.process ?? nodeProcess
  const randomId = dependencies.randomId ?? randomUUID

  const fileHandle = await openLeaseCandidate(options, dependencies, fileSystem)
  if (!fileHandle) {
    return undefined
  }

  const candidateIdentity =
    await readFileHandleIdentity(fileHandle).catch(ignoreFileError)
  if (!candidateIdentity) {
    await fileHandle.close().catch(ignoreFileError)
    return undefined
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
  if (!(await writeLeaseMetadata(fileHandle, metadata))) {
    await discardLeaseCandidate(
      options.filePath,
      fileHandle,
      candidateIdentity,
      fileSystem,
    )
    return undefined
  }

  const fileIdentity =
    await readFileHandleIdentity(fileHandle).catch(ignoreFileError)
  if (!fileIdentity) {
    await fileHandle.close().catch(ignoreFileError)
    return undefined
  }

  const lease = new OwnedFileLease<TPayload>({
    clock,
    createdAt,
    fileHandle,
    fileIdentity,
    filePath: options.filePath,
    fileSystem,
    ownerToken,
    payload: options.payload,
    pid: processBoundary.pid,
  })
  if (!(await lease.isOwner())) {
    await lease.release()
    return undefined
  }
  lease.startHeartbeat(options.heartbeatIntervalMs)
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
  for (;;) {
    const candidate = await openLeaseCandidateOnce(
      options,
      dependencies,
      fileSystem,
    )
    if (candidate !== RETRY_LEASE_CANDIDATE) {
      return candidate
    }
  }
}

const openLeaseCandidateOnce = async (
  options: Pick<
    TryAcquireOwnedFileLeaseOptions<unknown>,
    'filePath' | 'invalidStaleMs' | 'onReclaimed'
  >,
  dependencies: OwnedFileLeaseDependencies,
  fileSystem: FileSystemBoundary,
): Promise<FileHandle | typeof RETRY_LEASE_CANDIDATE | undefined> => {
  try {
    return await fileSystem.openExclusive(options.filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
    const reclaimed = await cleanupStaleOwnedFileLease(
      {
        filePath: options.filePath,
        invalidStaleMs: options.invalidStaleMs,
        ...(options.onReclaimed === undefined
          ? {}
          : { onReclaimed: options.onReclaimed }),
      },
      dependencies,
    )
    return reclaimed ? RETRY_LEASE_CANDIDATE : undefined
  }
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
  const [contentsResult, statsResult] = await Promise.allSettled([
    fileSystem.readText(options.filePath),
    fileSystem.stat(options.filePath),
  ])
  if (statsResult.status === 'rejected') {
    return isMissingFileError(statsResult.reason)
  }
  if (contentsResult.status === 'rejected') {
    return false
  }
  const contents = contentsResult.value
  const stats = statsResult.value

  const metadata = parseOwnedFileLeaseMetadata(contents)
  if (metadata && processBoundary.isAlive(metadata.pid)) {
    return false
  }
  if (!metadata && clock.now() - stats.mtimeMs < options.invalidStaleMs) {
    return false
  }

  const [currentContents, currentStats] = await Promise.all([
    fileSystem.readText(options.filePath).catch(ignoreFileError),
    fileSystem.stat(options.filePath).catch(ignoreFileError),
  ])
  if (
    currentContents !== contents ||
    !currentStats ||
    !isSameFile(stats, currentStats)
  ) {
    return false
  }

  try {
    await fileSystem.unlink(options.filePath)
  } catch (error) {
    if (isMissingFileError(error)) {
      return true
    }
    return fileSystem
      .stat(options.filePath)
      .then(() => false)
      .catch(isMissingFileError)
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
    if (
      value.schemaVersion !== OWNED_FILE_LEASE_SCHEMA_VERSION ||
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
): Promise<boolean> => {
  const bytes = Buffer.from(JSON.stringify(metadata), 'utf8')
  try {
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
        return false
      }
      offset += result.bytesWritten
    }
    return true
  } catch {
    return false
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
