import type { FileHandle } from 'node:fs/promises'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  type ClockBoundary,
  nodeFileSystem,
  type ProcessBoundary,
} from '../../src/service/boundaries.js'
import {
  GLOBAL_RECORDING_SLOT_ACTIVE_STALE_MS,
  GLOBAL_RECORDING_SLOT_INVALID_STALE_MS,
} from '../../src/service/constants.js'
import {
  createInProcessRecordingSlotState,
  PostProcessSlotScheduler,
  RecordingSlotScheduler,
} from '../../src/service/recording-slots.js'

const noopLogger = () => {}

const withTempDir = async (
  run: (tempDir: string) => Promise<void>,
): Promise<void> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-slots-'))
  try {
    await run(tempDir)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

const createClock = (
  initialNow = 0,
): ClockBoundary & {
  setNow(value: number): void
} => {
  let now = initialNow
  return {
    clearInterval: () => {},
    clearTimeout: () => {},
    delay: async (milliseconds) => {
      now += milliseconds
    },
    now: () => now,
    queueMicrotask,
    setInterval: () => ({}) as NodeJS.Timeout,
    setNow(value): void {
      now = value
    },
    setTimeout: () => ({}) as NodeJS.Timeout,
  }
}

const createProcess = (
  isAlive: (pid: number) => boolean = () => true,
): ProcessBoundary => ({
  environment: () => undefined,
  isAlive,
  pid: 12345,
  platform: 'linux',
})

describe('recording slot scheduler', () => {
  it('keeps post-processing capacity independent from recording capacity', async () => {
    const recordingState = createInProcessRecordingSlotState()
    const postProcessState = createInProcessRecordingSlotState()
    const recording = new RecordingSlotScheduler(
      { maxConcurrentRecordings: 1 },
      noopLogger,
      { inProcessState: recordingState },
    )
    const postProcess = new PostProcessSlotScheduler(
      { maxConcurrentPostProcesses: 1 },
      noopLogger,
      { inProcessState: postProcessState },
    )

    await expect(recording.acquire()).resolves.toBe(true)
    await expect(postProcess.acquire()).resolves.toBe(true)
    expect(recordingState.activeSlots).toBe(1)
    expect(postProcessState.activeSlots).toBe(1)

    await recording.release()
    await postProcess.release()
  })

  it('fast-fails post-processing contention and recovers exited-worker locks', async () => {
    await withTempDir(async (tempDir) => {
      const clock = createClock(100)
      const state = createInProcessRecordingSlotState()
      const lockDir = path.join(tempDir, 'post-process')
      await fs.mkdir(lockDir, { recursive: true })
      await fs.writeFile(
        path.join(lockDir, 'slot-1.lock'),
        JSON.stringify({ pid: 99, startedAt: 1, lastUpdatedAt: 1 }),
      )
      const scheduler = new PostProcessSlotScheduler(
        {
          globalRecordingLockDir: tempDir,
          maxConcurrentPostProcesses: 1,
          maxGlobalPostProcesses: 1,
          postProcessStartMode: 'fastFail',
          postProcessStartTimeoutMs: 150,
        },
        noopLogger,
        {
          clock,
          inProcessState: state,
          process: createProcess(() => false),
        },
      )

      await expect(scheduler.acquire()).resolves.toBe(true)
      expect(scheduler.ownedGlobalPostProcessSlotPath).toBe(
        path.join(lockDir, 'slot-1.lock'),
      )

      const blocked = new PostProcessSlotScheduler(
        {
          maxConcurrentPostProcesses: 1,
          postProcessStartMode: 'fastFail',
          postProcessStartTimeoutMs: 20,
        },
        noopLogger,
        { clock, inProcessState: state },
      )
      await expect(blocked.acquire()).resolves.toBe(false)
      await scheduler.release()
    })
  })

  it('uses no start timeout in blocking mode', () => {
    const scheduler = new RecordingSlotScheduler(
      { recordingStartMode: 'blocking', recordingStartTimeoutMs: 20 },
      noopLogger,
    )

    expect(scheduler.startTimeoutMs).toBeUndefined()
  })

  it('coordinates blocking in-process ownership across service adapters', async () => {
    const state = createInProcessRecordingSlotState()
    const first = new RecordingSlotScheduler(
      { maxConcurrentRecordings: 1 },
      noopLogger,
      { inProcessState: state },
    )
    const second = new RecordingSlotScheduler(
      { maxConcurrentRecordings: 1 },
      noopLogger,
      { inProcessState: state },
    )

    await expect(first.acquire()).resolves.toBe(true)
    const secondAcquire = second.acquire()
    await Promise.resolve()
    expect(second.ownsRecordingSlot).toBe(false)

    await first.release()
    await expect(secondAcquire).resolves.toBe(true)
    expect(second.ownsRecordingSlot).toBe(true)
    await second.release()
    expect(state.activeSlots).toBe(0)
  })

  it('bounds fast-fail waits through the injected clock', async () => {
    const clock = createClock()
    const state = createInProcessRecordingSlotState()
    state.activeSlots = 1
    const scheduler = new RecordingSlotScheduler(
      {
        maxConcurrentRecordings: 1,
        recordingStartMode: 'fastFail',
        recordingStartTimeoutMs: 20,
      },
      noopLogger,
      { clock, inProcessState: state },
    )

    await expect(scheduler.acquire()).resolves.toBe(false)
    expect(clock.now()).toBeGreaterThan(20)
    expect(scheduler.startTimeoutMs).toBe(20)
  })

  it('treats unlimited slots and repeated ownership as immediately available', async () => {
    const unlimited = new RecordingSlotScheduler({}, noopLogger)
    await expect(unlimited.acquire()).resolves.toBe(true)

    const state = createInProcessRecordingSlotState()
    const limited = new RecordingSlotScheduler(
      { maxConcurrentRecordings: 1 },
      noopLogger,
      { inProcessState: state },
    )
    await expect(limited.acquire()).resolves.toBe(true)
    await expect(limited.acquire()).resolves.toBe(true)
    expect(state.activeSlots).toBe(1)
    await limited.release()
  })

  it('resolves explicit and output-relative global lock directories', () => {
    const explicit = new RecordingSlotScheduler(
      {
        globalRecordingLockDir: 'lock-dir',
        outputDir: 'videos-output',
      },
      noopLogger,
    )
    const fallback = new RecordingSlotScheduler(
      { outputDir: 'videos-output' },
      noopLogger,
    )

    expect(explicit.resolveLockDir()).toBe('lock-dir')
    expect(fallback.resolveLockDir()).toBe(
      path.join('videos-output', '.wdio-video-global-slots'),
    )
  })

  it('writes global ownership metadata and releases the reserved file', async () => {
    await withTempDir(async (tempDir) => {
      const clock = createClock(100)
      const scheduler = new RecordingSlotScheduler(
        { globalRecordingLockDir: tempDir, maxGlobalRecordings: 1 },
        noopLogger,
        { clock, process: createProcess() },
      )

      await expect(scheduler.acquire()).resolves.toBe(true)
      const slotPath = scheduler.ownedGlobalRecordingSlotPath
      expect(slotPath).toBe(path.join(tempDir, 'slot-1.lock'))
      const metadata = JSON.parse(
        await fs.readFile(slotPath ?? '', 'utf8'),
      ) as Record<string, unknown>
      expect(metadata).toMatchObject({
        ownerId: expect.any(String),
        pid: 12345,
        startedAt: 100,
        lastUpdatedAt: 100,
      })

      await scheduler.release()
      await expect(fs.stat(slotPath ?? '')).rejects.toThrow()
      expect(scheduler.ownsGlobalRecordingSlot).toBe(false)
    })
  })

  it('discards a global slot candidate when metadata cannot be written', async () => {
    const close = vi.fn(async () => {})
    const unlink = vi.fn(async () => {})
    const fileHandle = {
      close,
      truncate: async () => {},
      write: async () => ({ bytesWritten: 0 }),
    } as unknown as FileHandle
    const scheduler = new RecordingSlotScheduler(
      { maxGlobalRecordings: 1 },
      noopLogger,
      {
        fileSystem: {
          ...nodeFileSystem,
          openExclusive: async () => fileHandle,
          unlink,
        },
      },
    )

    await expect(scheduler.openOwnedGlobalSlot('slot.lock')).resolves.toBe(
      false,
    )
    expect(close).toHaveBeenCalledOnce()
    expect(unlink).toHaveBeenCalledWith('slot.lock')
    expect(scheduler.ownsGlobalRecordingSlot).toBe(false)
  })

  it('keeps live-process slots even when their heartbeat is stale', async () => {
    await withTempDir(async (tempDir) => {
      const slotPath = path.join(tempDir, 'slot.lock')
      const clock = createClock(50_000)
      const scheduler = new RecordingSlotScheduler({}, noopLogger, {
        clock,
        process: createProcess(() => true),
      })

      await fs.writeFile(
        slotPath,
        JSON.stringify({ pid: 99, lastUpdatedAt: clock.now() }),
      )
      await scheduler.cleanupStaleGlobalSlot(slotPath)
      await expect(fs.stat(slotPath)).resolves.toBeDefined()

      await fs.writeFile(
        slotPath,
        JSON.stringify({
          pid: 99,
          lastUpdatedAt:
            clock.now() - GLOBAL_RECORDING_SLOT_ACTIVE_STALE_MS - 1,
        }),
      )
      await scheduler.cleanupStaleGlobalSlot(slotPath)
      await expect(fs.stat(slotPath)).resolves.toBeDefined()
    })
  })

  it('does not remove a replacement lock when an old owner releases', async () => {
    await withTempDir(async (tempDir) => {
      const scheduler = new RecordingSlotScheduler(
        { globalRecordingLockDir: tempDir, maxGlobalRecordings: 1 },
        noopLogger,
        { clock: createClock(100), process: createProcess() },
      )
      await scheduler.acquire()
      const slotPath = scheduler.ownedGlobalRecordingSlotPath
      expect(slotPath).toBeDefined()
      await fs.writeFile(
        slotPath ?? '',
        JSON.stringify({
          ownerId: 'replacement-owner',
          pid: 22222,
          startedAt: 200,
          lastUpdatedAt: 200,
        }),
      )

      await scheduler.release()

      await expect(fs.readFile(slotPath ?? '', 'utf8')).resolves.toContain(
        'replacement-owner',
      )
    })
  })

  it('removes exited-process slots through the process boundary', async () => {
    await withTempDir(async (tempDir) => {
      const slotPath = path.join(tempDir, 'slot.lock')
      await fs.writeFile(slotPath, JSON.stringify({ pid: 99 }))
      const scheduler = new RecordingSlotScheduler({}, noopLogger, {
        process: createProcess(() => false),
      })

      await scheduler.cleanupStaleGlobalSlot(slotPath)
      await expect(fs.stat(slotPath)).rejects.toThrow()
    })
  })

  it('honors the invalid-slot grace window through the clock boundary', async () => {
    const clock = createClock(10_000)
    const scheduler = new RecordingSlotScheduler({}, noopLogger, { clock })

    expect(
      scheduler.shouldCleanupInvalidGlobalSlot(
        clock.now() - GLOBAL_RECORDING_SLOT_INVALID_STALE_MS + 1,
      ),
    ).toBe(false)
    expect(
      scheduler.shouldCleanupInvalidGlobalSlot(
        clock.now() - GLOBAL_RECORDING_SLOT_INVALID_STALE_MS,
      ),
    ).toBe(true)
  })

  it('resolves heartbeat, start, and filesystem timestamps in precedence order', () => {
    const scheduler = new RecordingSlotScheduler({}, noopLogger)

    expect(
      scheduler.resolveLastUpdatedAt({ lastUpdatedAt: 30, startedAt: 20 }, 10),
    ).toBe(30)
    expect(scheduler.resolveLastUpdatedAt({ startedAt: 20 }, 10)).toBe(20)
    expect(scheduler.resolveLastUpdatedAt(undefined, 10)).toBe(10)
  })

  it('allows repeated release calls when no slot is owned', async () => {
    const scheduler = new RecordingSlotScheduler({}, noopLogger)

    await expect(scheduler.release()).resolves.toBeUndefined()
    await expect(scheduler.release()).resolves.toBeUndefined()
  })

  it('falls back from global acquisition and releases its in-process slot', async () => {
    const state = createInProcessRecordingSlotState()
    const clock = createClock()
    const scheduler = new RecordingSlotScheduler(
      {
        maxConcurrentRecordings: 1,
        maxGlobalRecordings: 1,
        recordingStartMode: 'fastFail',
        recordingStartTimeoutMs: 0,
      },
      noopLogger,
      {
        clock,
        fileSystem: {
          ...nodeFileSystem,
          mkdir: async () => {},
          openExclusive: async () => {
            const error = new Error('occupied') as NodeJS.ErrnoException
            error.code = 'EACCES'
            throw error
          },
        },
        inProcessState: state,
      },
    )

    await expect(scheduler.acquire()).resolves.toBe(false)
    expect(state.activeSlots).toBe(0)
    expect(scheduler.ownsRecordingSlot).toBe(false)
  })
})
