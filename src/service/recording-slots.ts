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
  GLOBAL_RECORDING_SLOT_INVALID_STALE_MS,
  GLOBAL_RECORDING_SLOT_POLL_MS,
  GLOBAL_RECORDING_SLOT_TIMEOUT_MS,
  IN_PROCESS_RECORDING_SLOT_POLL_MS,
} from './constants.js'
import { resolveGlobalSlotRunDirectories } from './global-slot-directory.js'
import { createLauncherRegistrationError } from './launcher-context.js'
import type { ServiceLogger } from './logging.js'
import {
  isTransientLeaseFileError,
  type OwnedFileLease,
  OwnedFileLeaseOperationalError,
  tryAcquireOwnedFileLease,
} from './owned-file-lease.js'

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
  runId?: string
}

/** Ends a slot wait early: an aborted wait acquires nothing. */
export interface SlotWaitOptions {
  readonly signal?: AbortSignal
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

interface GlobalSlotAttempt {
  readonly acquired: boolean
  readonly canRetry: boolean
  readonly failures: unknown[]
}

export class RecordingSlotScheduler {
  private readonly clock: ClockBoundary
  private readonly fileSystem: FileSystemBoundary
  private readonly inProcessState: InProcessRecordingSlotState
  private readonly log: ServiceLogger
  private readonly options: RecordingSlotSchedulerOptions
  private readonly process: ProcessBoundary
  private readonly resourceLabel: 'recording' | 'post-processing'
  private globalSlotLease: OwnedFileLease | undefined
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

  async acquire(options: SlotWaitOptions = {}): Promise<boolean> {
    if (
      this.ownsInProcessSlot &&
      ((this.options.maxGlobalRecordings ?? 0) <= 0 || this.ownsGlobalSlot)
    ) {
      return true
    }
    const { signal } = options
    if (signal?.aborted) {
      return false
    }

    const inProcessSlotAcquired = await this.acquireInProcess(
      this.startTimeoutMs,
      signal,
    )
    if (!inProcessSlotAcquired) {
      return false
    }

    try {
      const globalSlotAcquired =
        !signal?.aborted &&
        (await this.acquireGlobal(this.startTimeoutMs, signal))
      if (globalSlotAcquired) {
        return true
      }

      this.releaseInProcess()
      return false
    } catch (error) {
      this.releaseInProcess()
      throw error
    }
  }

  async acquireInProcess(
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const maxConcurrentRecordings = this.options.maxConcurrentRecordings ?? 0
    if (maxConcurrentRecordings <= 0 || this.ownsInProcessSlot) {
      return true
    }
    if (signal?.aborted) {
      return false
    }

    if (timeoutMs !== undefined) {
      const deadline = this.clock.now() + Math.max(0, timeoutMs)
      while (this.clock.now() <= deadline && !signal?.aborted) {
        if (this.tryAcquireInProcess(maxConcurrentRecordings)) {
          return true
        }
        await this.clock.delay(IN_PROCESS_RECORDING_SLOT_POLL_MS, signal)
      }

      return false
    }

    return this.waitForInProcessSlot(maxConcurrentRecordings, signal)
  }

  /**
   * Queues for the next freed slot. A cancelled waiter leaves the queue, and
   * a wake-up that reaches it after the cancellation passes to the next one,
   * so a freed slot is never lost.
   */
  private waitForInProcessSlot(
    maxConcurrentRecordings: number,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const { waiters } = this.inProcessState
      const onAbort = (): void => {
        const index = waiters.indexOf(tryAcquire)
        if (index !== -1) {
          waiters.splice(index, 1)
        }
        resolve(false)
      }
      const tryAcquire = (): void => {
        if (signal?.aborted) {
          this.wakeNextWaiter()
          return
        }
        if (this.tryAcquireInProcess(maxConcurrentRecordings)) {
          signal?.removeEventListener('abort', onAbort)
          resolve(true)
          return
        }
        waiters.push(tryAcquire)
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      tryAcquire()
    })
  }

  async acquireGlobal(
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const maxGlobalRecordings = this.options.maxGlobalRecordings ?? 0
    if (maxGlobalRecordings <= 0 || this.ownsGlobalSlot) {
      return true
    }

    const lockDir = this.resolveLockDir()
    await this.fileSystem.mkdir(lockDir).catch((error: unknown) => {
      throw new OwnedFileLeaseOperationalError(
        lockDir,
        'create the global slot directory',
        error,
      )
    })
    // A wait cancelled while the directory was made takes no slot.
    if (signal?.aborted) {
      return false
    }

    const timeout = timeoutMs ?? GLOBAL_RECORDING_SLOT_TIMEOUT_MS
    const deadline = this.clock.now() + Math.max(0, timeout)
    let attempt: GlobalSlotAttempt
    do {
      attempt = await this.tryAcquireGlobal(lockDir, maxGlobalRecordings)
      if (attempt.acquired) {
        return true
      }

      if (!attempt.canRetry || this.clock.now() >= deadline) {
        break
      }

      // An aborted wait wakes at once, and polls no more.
      await this.clock.delay(
        Math.min(
          GLOBAL_RECORDING_SLOT_POLL_MS,
          Math.max(0, deadline - this.clock.now()),
        ),
        signal,
      )
    } while (this.clock.now() <= deadline && !signal?.aborted)

    if (signal?.aborted) {
      return false
    }
    if (attempt.failures.length > 0) {
      throw new AggregateError(
        attempt.failures,
        `[WdioPuppeteerVideoService] Failed to acquire a global ${this.resourceLabel} slot in ${lockDir} due to storage errors.`,
      )
    }

    return false
  }

  async tryAcquireGlobal(
    lockDir: string,
    maxGlobalRecordings: number,
  ): Promise<GlobalSlotAttempt> {
    const failures: unknown[] = []
    let canRetry = false
    for (let slotIndex = 1; slotIndex <= maxGlobalRecordings; slotIndex += 1) {
      const slotPath = path.join(lockDir, `slot-${slotIndex}.lock`)
      try {
        const acquired = await this.openOwnedGlobalSlot(slotPath)
        if (acquired) {
          return { acquired: true, canRetry: false, failures: [] }
        }
        canRetry = true
      } catch (error) {
        failures.push(error)
        canRetry ||= isTransientLeaseFileError(error, this.process.platform)
      }
    }

    return { acquired: false, canRetry, failures }
  }

  async openOwnedGlobalSlot(slotPath: string): Promise<boolean> {
    const lease = await tryAcquireOwnedFileLease<GlobalSlotPayload>(
      {
        filePath: slotPath,
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
    const runId = this.options.runId
    if (runId === undefined) {
      throw createLauncherRegistrationError('missing')
    }
    const directories = resolveGlobalSlotRunDirectories({
      ...(this.options.globalRecordingLockDir === undefined
        ? {}
        : { lockDir: this.options.globalRecordingLockDir }),
      ...(this.options.outputDir === undefined
        ? {}
        : { outputDir: this.options.outputDir }),
      runId,
    })
    return this.resourceLabel === 'post-processing'
      ? directories.postProcess
      : directories.recording
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

    this.wakeNextWaiter()
  }

  private wakeNextWaiter(): void {
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
      runId?: string
    },
    log: ServiceLogger,
    dependencies: RecordingSlotSchedulerDependencies = {},
  ) {
    this.scheduler = new RecordingSlotScheduler(
      {
        resourceLabel: 'post-processing',
        ...(options.globalRecordingLockDir === undefined
          ? {}
          : { globalRecordingLockDir: options.globalRecordingLockDir }),
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
        ...(options.runId === undefined ? {} : { runId: options.runId }),
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

  acquire(options?: SlotWaitOptions): Promise<boolean> {
    return this.scheduler.acquire(options)
  }

  release(): Promise<void> {
    return this.scheduler.release()
  }
}
