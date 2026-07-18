import { randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import type { InternalRecordingStartMode } from '../types.js'
import {
  type ClockBoundary,
  type FileSystemBoundary,
  nodeFileSystem,
  nodeProcess,
  type ProcessBoundary,
  systemClock,
} from './boundaries.js'
import {
  GLOBAL_POST_PROCESS_SLOT_DIR_NAME,
  GLOBAL_RECORDING_SLOT_ACTIVE_STALE_MS,
  GLOBAL_RECORDING_SLOT_HEARTBEAT_MS,
  GLOBAL_RECORDING_SLOT_INVALID_STALE_MS,
  GLOBAL_RECORDING_SLOT_POLL_MS,
  GLOBAL_RECORDING_SLOT_TIMEOUT_MS,
  IN_PROCESS_RECORDING_SLOT_POLL_MS,
} from './constants.js'
import type { ServiceLogger } from './logging.js'
import {
  type GlobalRecordingSlotMetadata,
  parseGlobalRecordingSlotMetadata,
  resolveGlobalRecordingLockDir,
} from './retry-state.js'

export interface InProcessRecordingSlotState {
  activeSlots: number
  waiters: Array<() => void>
}

export interface RecordingSlotSchedulerDependencies {
  clock?: ClockBoundary
  fileSystem?: FileSystemBoundary
  inProcessState?: InProcessRecordingSlotState
  process?: ProcessBoundary
}

export interface RecordingSlotSchedulerOptions {
  globalRecordingLockDir?: string
  maxConcurrentRecordings?: number
  maxGlobalRecordings?: number
  outputDir?: string
  recordingStartMode?: InternalRecordingStartMode
  recordingStartTimeoutMs?: number
  resourceLabel?: 'recording' | 'post-processing'
}

export const createInProcessRecordingSlotState =
  (): InProcessRecordingSlotState => ({
    activeSlots: 0,
    waiters: [],
  })

const sharedInProcessState = createInProcessRecordingSlotState()
const sharedPostProcessState = createInProcessRecordingSlotState()
const ignoreFileError = (): undefined => undefined
const emptyTextOnFileError = (): string => ''

export class RecordingSlotScheduler {
  private readonly clock: ClockBoundary
  private readonly fileSystem: FileSystemBoundary
  private readonly inProcessState: InProcessRecordingSlotState
  private readonly log: ServiceLogger
  private readonly options: RecordingSlotSchedulerOptions
  private readonly process: ProcessBoundary
  private readonly resourceLabel: 'recording' | 'post-processing'
  private globalSlotFileHandle: FileHandle | undefined
  private globalSlotHeartbeatTimer: NodeJS.Timeout | undefined
  private globalSlotOwnerId: string | undefined
  private globalSlotPath: string | undefined
  private globalSlotStartedAt: number | undefined
  private ownsGlobalSlot = false
  private ownsInProcessSlot = false

  constructor(
    options: RecordingSlotSchedulerOptions,
    log: ServiceLogger,
    dependencies: RecordingSlotSchedulerDependencies = {},
  ) {
    this.clock = dependencies.clock ?? systemClock
    this.fileSystem = dependencies.fileSystem ?? nodeFileSystem
    this.inProcessState = dependencies.inProcessState ?? sharedInProcessState
    this.log = log
    this.options = options
    this.process = dependencies.process ?? nodeProcess
    this.resourceLabel = options.resourceLabel ?? 'recording'
  }

  get ownsRecordingSlot(): boolean {
    return this.ownsInProcessSlot
  }

  get ownsGlobalRecordingSlot(): boolean {
    return this.ownsGlobalSlot
  }

  get ownedGlobalRecordingSlotPath(): string | undefined {
    return this.globalSlotPath
  }

  get startTimeoutMs(): number | undefined {
    if ((this.options.recordingStartMode ?? 'blocking') !== 'fastFail') {
      return undefined
    }

    return this.options.recordingStartTimeoutMs
  }

  async acquire(): Promise<boolean> {
    if (
      this.ownsInProcessSlot &&
      ((this.options.maxGlobalRecordings ?? 0) <= 0 || this.ownsGlobalSlot)
    ) {
      return true
    }

    const inProcessSlotAcquired = await this.acquireInProcess(
      this.startTimeoutMs,
    )
    if (!inProcessSlotAcquired) {
      return false
    }

    const globalSlotAcquired = await this.acquireGlobal(this.startTimeoutMs)
    if (globalSlotAcquired) {
      return true
    }

    this.releaseInProcess()
    return false
  }

  async acquireInProcess(timeoutMs: number | undefined): Promise<boolean> {
    const maxConcurrentRecordings = this.options.maxConcurrentRecordings ?? 0
    if (maxConcurrentRecordings <= 0 || this.ownsInProcessSlot) {
      return true
    }

    if (timeoutMs !== undefined) {
      const deadline = this.clock.now() + Math.max(0, timeoutMs)
      while (this.clock.now() <= deadline) {
        if (this.tryAcquireInProcess(maxConcurrentRecordings)) {
          return true
        }
        await this.clock.delay(IN_PROCESS_RECORDING_SLOT_POLL_MS)
      }

      return false
    }

    await new Promise<void>((resolve) => {
      const tryAcquire = (): void => {
        if (this.tryAcquireInProcess(maxConcurrentRecordings)) {
          resolve()
          return
        }

        this.inProcessState.waiters.push(tryAcquire)
      }

      tryAcquire()
    })

    return true
  }

  async acquireGlobal(timeoutMs: number | undefined): Promise<boolean> {
    const maxGlobalRecordings = this.options.maxGlobalRecordings ?? 0
    if (maxGlobalRecordings <= 0 || this.ownsGlobalSlot) {
      return true
    }

    const lockDir = this.resolveLockDir()
    await this.fileSystem.mkdir(lockDir).catch(() => {
      /* best-effort lock-dir creation */
    })

    const timeout = timeoutMs ?? GLOBAL_RECORDING_SLOT_TIMEOUT_MS
    const deadline = this.clock.now() + Math.max(0, timeout)
    while (this.clock.now() <= deadline) {
      const acquired = await this.tryAcquireGlobal(lockDir, maxGlobalRecordings)
      if (acquired) {
        return true
      }

      if (this.clock.now() >= deadline) {
        break
      }

      await this.clock.delay(GLOBAL_RECORDING_SLOT_POLL_MS)
    }

    return false
  }

  async tryAcquireGlobal(
    lockDir: string,
    maxGlobalRecordings: number,
  ): Promise<boolean> {
    for (let slotIndex = 1; slotIndex <= maxGlobalRecordings; slotIndex += 1) {
      const slotPath = path.join(lockDir, `slot-${slotIndex}.lock`)
      try {
        const acquired = await this.openOwnedGlobalSlot(slotPath)
        if (acquired) {
          return true
        }
      } catch (error) {
        const slotError = error as NodeJS.ErrnoException
        if (slotError.code === 'EEXIST') {
          await this.cleanupStaleGlobalSlot(slotPath)
        }
      }
    }

    return false
  }

  async openOwnedGlobalSlot(slotPath: string): Promise<boolean> {
    const fileHandle = await this.fileSystem.openExclusive(slotPath)
    const startedAt = this.clock.now()
    const ownerId = randomUUID()
    const metadataWritten = await this.writeGlobalSlotMetadata(
      fileHandle,
      startedAt,
      ownerId,
    )
    if (!metadataWritten) {
      this.log(
        'debug',
        `[WdioPuppeteerVideoService] Discarding global ${this.resourceLabel} slot candidate without metadata: ${slotPath}`,
      )
      await this.discardGlobalSlotCandidate(slotPath, fileHandle)
      return false
    }

    this.ownsGlobalSlot = true
    this.globalSlotPath = slotPath
    this.globalSlotFileHandle = fileHandle
    this.globalSlotOwnerId = ownerId
    this.globalSlotStartedAt = startedAt
    this.startGlobalSlotHeartbeat()
    this.log(
      'debug',
      `[WdioPuppeteerVideoService] Acquired global ${this.resourceLabel} slot: ${slotPath}`,
    )
    return true
  }

  async writeGlobalSlotMetadata(
    fileHandle: FileHandle,
    startedAt: number,
    ownerId: string,
  ): Promise<boolean> {
    const metadata = Buffer.from(
      JSON.stringify({
        ownerId,
        pid: this.process.pid,
        startedAt,
        lastUpdatedAt: this.clock.now(),
      }),
      'utf8',
    )

    try {
      await fileHandle.truncate(0)
      let bytesWritten = 0
      while (bytesWritten < metadata.length) {
        const writeResult = await fileHandle.write(
          metadata,
          bytesWritten,
          metadata.length - bytesWritten,
          bytesWritten,
        )
        if (writeResult.bytesWritten <= 0) {
          return false
        }
        bytesWritten += writeResult.bytesWritten
      }
      return true
    } catch {
      return false
    }
  }

  async cleanupStaleGlobalSlot(slotPath: string): Promise<void> {
    const slotStats = await this.fileSystem
      .stat(slotPath)
      .catch(ignoreFileError)
    if (!slotStats) {
      return
    }

    const fileContents = await this.fileSystem
      .readText(slotPath)
      .catch(emptyTextOnFileError)
    const slotMetadata = parseGlobalRecordingSlotMetadata(fileContents)
    const parsedPid = slotMetadata?.pid
    if (parsedPid) {
      const lastUpdatedAtMs = this.resolveLastUpdatedAt(
        slotMetadata,
        slotStats.mtimeMs,
      )
      if (this.process.isAlive(parsedPid)) {
        this.log(
          'debug',
          `[WdioPuppeteerVideoService] Keeping live-process global ${this.resourceLabel} slot${this.isActiveGlobalSlotFresh(lastUpdatedAtMs) ? '' : ' despite its expired heartbeat'} for pid=${parsedPid}: ${slotPath}`,
        )
        return
      }

      this.log(
        'debug',
        `[WdioPuppeteerVideoService] Removing stale global ${this.resourceLabel} slot for exited pid=${parsedPid}: ${slotPath}`,
      )
      await this.unlinkGlobalSlotIfUnchanged(slotPath, fileContents, slotStats)
      return
    }

    if (!this.shouldCleanupInvalidGlobalSlot(slotStats.mtimeMs)) {
      this.log(
        'debug',
        `[WdioPuppeteerVideoService] Keeping recent invalid global ${this.resourceLabel} slot during grace window: ${slotPath}`,
      )
      return
    }

    this.log(
      'debug',
      `[WdioPuppeteerVideoService] Removing stale invalid global ${this.resourceLabel} slot: ${slotPath}`,
    )
    await this.unlinkGlobalSlotIfUnchanged(slotPath, fileContents, slotStats)
  }

  shouldCleanupInvalidGlobalSlot(lastUpdatedAtMs: number): boolean {
    return (
      this.clock.now() - lastUpdatedAtMs >=
      GLOBAL_RECORDING_SLOT_INVALID_STALE_MS
    )
  }

  isActiveGlobalSlotFresh(lastUpdatedAtMs: number): boolean {
    return (
      this.clock.now() - lastUpdatedAtMs < GLOBAL_RECORDING_SLOT_ACTIVE_STALE_MS
    )
  }

  resolveLastUpdatedAt(
    metadata: GlobalRecordingSlotMetadata | undefined,
    fallbackLastUpdatedAtMs: number,
  ): number {
    return (
      metadata?.lastUpdatedAt ?? metadata?.startedAt ?? fallbackLastUpdatedAtMs
    )
  }

  resolveLockDir(): string {
    return resolveGlobalRecordingLockDir(
      this.options.outputDir,
      this.options.globalRecordingLockDir,
    )
  }

  async release(): Promise<void> {
    await this.releaseGlobal()
    this.releaseInProcess()
  }

  releaseInProcess(): void {
    if (!this.ownsInProcessSlot) {
      return
    }

    this.ownsInProcessSlot = false
    if (this.inProcessState.activeSlots > 0) {
      this.inProcessState.activeSlots -= 1
    }
    this.log(
      'debug',
      `[WdioPuppeteerVideoService] Released in-process ${this.resourceLabel} slot (${this.inProcessState.activeSlots}/${this.options.maxConcurrentRecordings ?? 0}).`,
    )

    const nextWaiter = this.inProcessState.waiters.shift()
    if (nextWaiter) {
      this.clock.queueMicrotask(nextWaiter)
    }
  }

  async releaseGlobal(): Promise<void> {
    if (!this.ownsGlobalSlot) {
      return
    }

    const lockPath = this.globalSlotPath
    const lockFileHandle = this.globalSlotFileHandle
    const ownerId = this.globalSlotOwnerId
    this.stopGlobalSlotHeartbeat()
    this.ownsGlobalSlot = false
    this.globalSlotPath = undefined
    this.globalSlotFileHandle = undefined
    this.globalSlotOwnerId = undefined
    this.globalSlotStartedAt = undefined

    if (!lockFileHandle) {
      return
    }
    await lockFileHandle.close().catch(() => {
      /* best-effort slot close */
    })
    if (
      lockPath &&
      ownerId &&
      (await this.isGlobalSlotOwner(lockPath, ownerId))
    ) {
      await this.unlinkBestEffort(lockPath)
      this.log(
        'debug',
        `[WdioPuppeteerVideoService] Released global ${this.resourceLabel} slot: ${lockPath}`,
      )
    }
  }

  async refreshGlobalSlotHeartbeat(): Promise<void> {
    const slotPath = this.globalSlotPath
    const fileHandle = this.globalSlotFileHandle
    const startedAt = this.globalSlotStartedAt
    const ownerId = this.globalSlotOwnerId

    if (
      !this.ownsGlobalSlot ||
      !slotPath ||
      !fileHandle ||
      !ownerId ||
      startedAt === undefined
    ) {
      return
    }

    const metadataWritten = await this.writeGlobalSlotMetadata(
      fileHandle,
      startedAt,
      ownerId,
    )
    if (!metadataWritten) {
      this.log(
        'trace',
        `[WdioPuppeteerVideoService] Failed to refresh global ${this.resourceLabel} slot heartbeat: ${slotPath}`,
      )
    }
  }

  private tryAcquireInProcess(maxConcurrentRecordings: number): boolean {
    if (this.inProcessState.activeSlots >= maxConcurrentRecordings) {
      return false
    }

    this.inProcessState.activeSlots += 1
    this.ownsInProcessSlot = true
    this.log(
      'debug',
      `[WdioPuppeteerVideoService] Acquired in-process ${this.resourceLabel} slot (${this.inProcessState.activeSlots}/${maxConcurrentRecordings}).`,
    )
    return true
  }

  private async discardGlobalSlotCandidate(
    slotPath: string,
    fileHandle: FileHandle,
  ): Promise<void> {
    await fileHandle.close().catch(() => {
      /* best-effort slot close */
    })
    await this.unlinkBestEffort(slotPath)
  }

  private startGlobalSlotHeartbeat(): void {
    if (
      !this.ownsGlobalSlot ||
      !this.globalSlotPath ||
      this.globalSlotStartedAt === undefined ||
      this.globalSlotHeartbeatTimer
    ) {
      return
    }

    this.globalSlotHeartbeatTimer = this.clock.setInterval(() => {
      void this.refreshGlobalSlotHeartbeat()
    }, GLOBAL_RECORDING_SLOT_HEARTBEAT_MS)
    this.globalSlotHeartbeatTimer.unref?.()
  }

  private stopGlobalSlotHeartbeat(): void {
    if (!this.globalSlotHeartbeatTimer) {
      return
    }

    this.clock.clearInterval(this.globalSlotHeartbeatTimer)
    this.globalSlotHeartbeatTimer = undefined
  }

  private async unlinkBestEffort(filePath: string): Promise<void> {
    await this.fileSystem.unlink(filePath).catch(() => {
      /* best-effort cleanup */
    })
  }

  private async isGlobalSlotOwner(
    slotPath: string,
    ownerId: string,
  ): Promise<boolean> {
    const contents = await this.fileSystem
      .readText(slotPath)
      .catch(emptyTextOnFileError)
    return parseGlobalRecordingSlotMetadata(contents)?.ownerId === ownerId
  }

  private async unlinkGlobalSlotIfUnchanged(
    slotPath: string,
    expectedContents: string,
    expectedStats: Awaited<ReturnType<FileSystemBoundary['stat']>>,
  ): Promise<void> {
    const [currentContents, currentStats] = await Promise.all([
      this.fileSystem.readText(slotPath).catch(ignoreFileError),
      this.fileSystem.stat(slotPath).catch(ignoreFileError),
    ])
    if (
      currentContents !== expectedContents ||
      !currentStats ||
      !this.isSameFile(expectedStats, currentStats)
    ) {
      return
    }
    await this.unlinkBestEffort(slotPath)
  }

  private isSameFile(
    expected: Awaited<ReturnType<FileSystemBoundary['stat']>>,
    current: Awaited<ReturnType<FileSystemBoundary['stat']>>,
  ): boolean {
    if (expected.ino !== undefined && current.ino !== undefined) {
      return expected.ino === current.ino
    }
    return (
      expected.mtimeMs === current.mtimeMs &&
      (expected.size === undefined ||
        current.size === undefined ||
        expected.size === current.size)
    )
  }
}

export class PostProcessSlotScheduler {
  private readonly scheduler: RecordingSlotScheduler

  constructor(
    options: {
      globalRecordingLockDir?: string
      maxConcurrentPostProcesses?: number
      maxGlobalPostProcesses?: number
      outputDir?: string
      postProcessStartMode?: InternalRecordingStartMode
      postProcessStartTimeoutMs?: number
    },
    log: ServiceLogger,
    dependencies: RecordingSlotSchedulerDependencies = {},
  ) {
    const lockDir = options.globalRecordingLockDir?.trim()
      ? path.join(options.globalRecordingLockDir, 'post-process')
      : path.join(
          options.outputDir ?? 'videos',
          GLOBAL_POST_PROCESS_SLOT_DIR_NAME,
        )
    this.scheduler = new RecordingSlotScheduler(
      {
        globalRecordingLockDir: lockDir,
        resourceLabel: 'post-processing',
        ...(options.maxConcurrentPostProcesses === undefined
          ? {}
          : {
              maxConcurrentRecordings: options.maxConcurrentPostProcesses,
            }),
        ...(options.maxGlobalPostProcesses === undefined
          ? {}
          : { maxGlobalRecordings: options.maxGlobalPostProcesses }),
        ...(options.outputDir === undefined
          ? {}
          : { outputDir: options.outputDir }),
        ...(options.postProcessStartMode === undefined
          ? {}
          : { recordingStartMode: options.postProcessStartMode }),
        ...(options.postProcessStartTimeoutMs === undefined
          ? {}
          : {
              recordingStartTimeoutMs: options.postProcessStartTimeoutMs,
            }),
      },
      log,
      {
        ...dependencies,
        inProcessState: dependencies.inProcessState ?? sharedPostProcessState,
      },
    )
  }

  get ownsPostProcessSlot(): boolean {
    return this.scheduler.ownsRecordingSlot
  }

  get ownsGlobalPostProcessSlot(): boolean {
    return this.scheduler.ownsGlobalRecordingSlot
  }

  get ownedGlobalPostProcessSlotPath(): string | undefined {
    return this.scheduler.ownedGlobalRecordingSlotPath
  }

  acquire(): Promise<boolean> {
    return this.scheduler.acquire()
  }

  release(): Promise<void> {
    return this.scheduler.release()
  }
}
