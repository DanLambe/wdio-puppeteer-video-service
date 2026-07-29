import path from 'node:path'
import type { RecordingStartMode } from '../types.js'
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
  GLOBAL_RECORDING_SLOT_HEARTBEAT_MS,
  GLOBAL_RECORDING_SLOT_INVALID_STALE_MS,
  GLOBAL_RECORDING_SLOT_POLL_MS,
  GLOBAL_RECORDING_SLOT_TIMEOUT_MS,
  IN_PROCESS_RECORDING_SLOT_POLL_MS,
} from './constants.js'
import type { ServiceLogger } from './logging.js'
import {
  type OwnedFileLease,
  tryAcquireOwnedFileLease,
} from './owned-file-lease.js'
import { resolveGlobalRecordingLockDir } from './retry-state.js'

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
  globalRecordingLockDir?: string | undefined
  maxConcurrentRecordings?: number
  maxGlobalRecordings?: number
  outputDir?: string
  recordingStartMode?: RecordingStartMode
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

interface GlobalSlotPayload {
  readonly resource: 'recording' | 'post-processing'
}

export class RecordingSlotScheduler {
  private readonly clock: ClockBoundary
  private readonly fileSystem: FileSystemBoundary
  private readonly inProcessState: InProcessRecordingSlotState
  private readonly log: ServiceLogger
  private readonly options: RecordingSlotSchedulerOptions
  private readonly process: ProcessBoundary
  private readonly resourceLabel: 'recording' | 'post-processing'
  private globalSlotLease: OwnedFileLease<GlobalSlotPayload> | undefined
  private globalSlotPath: string | undefined
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
    if ((this.options.recordingStartMode ?? 'blocking') !== 'fast-fail') {
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
      } catch {
        // An unusable slot candidate must not block checking other capacity.
      }
    }

    return false
  }

  async openOwnedGlobalSlot(slotPath: string): Promise<boolean> {
    const lease = await tryAcquireOwnedFileLease<GlobalSlotPayload>(
      {
        filePath: slotPath,
        heartbeatIntervalMs: GLOBAL_RECORDING_SLOT_HEARTBEAT_MS,
        invalidStaleMs: GLOBAL_RECORDING_SLOT_INVALID_STALE_MS,
        payload: { resource: this.resourceLabel },
      },
      {
        clock: this.clock,
        fileSystem: this.fileSystem,
        process: this.process,
      },
    )
    if (!lease) {
      this.log(
        'debug',
        `[WdioPuppeteerVideoService] Global ${this.resourceLabel} slot is already owned: ${slotPath}`,
      )
      return false
    }

    this.ownsGlobalSlot = true
    this.globalSlotPath = slotPath
    this.globalSlotLease = lease
    this.log(
      'debug',
      `[WdioPuppeteerVideoService] Acquired global ${this.resourceLabel} slot: ${slotPath}`,
    )
    return true
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
    const lease = this.globalSlotLease
    this.ownsGlobalSlot = false
    this.globalSlotPath = undefined
    this.globalSlotLease = undefined

    if (!lease) {
      return
    }
    if (await lease.release()) {
      this.log(
        'debug',
        `[WdioPuppeteerVideoService] Released global ${this.resourceLabel} slot: ${lockPath}`,
      )
    }
  }

  async refreshGlobalSlotHeartbeat(): Promise<void> {
    const slotPath = this.globalSlotPath
    const lease = this.globalSlotLease
    if (!this.ownsGlobalSlot || !slotPath || !lease) {
      return
    }

    if (!(await lease.refresh())) {
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
}

export class PostProcessSlotScheduler {
  private readonly scheduler: RecordingSlotScheduler

  constructor(
    options: {
      globalRecordingLockDir?: string | undefined
      maxConcurrentPostProcesses?: number
      maxGlobalPostProcesses?: number
      outputDir?: string
      postProcessStartMode?: RecordingStartMode
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
