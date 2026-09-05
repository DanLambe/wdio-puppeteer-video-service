import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  nodeFileSystem,
  nodeProcess,
  systemClock,
} from '../../src/service/boundaries.js'
import {
  createInProcessRecordingSlotState,
  RecordingSlotScheduler,
} from '../../src/service/recording-slots.js'

const withSlotDirectory = async (
  test: (lockDir: string) => Promise<void>,
): Promise<void> => {
  const lockDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slot-retry-'))
  try {
    await test(lockDir)
  } finally {
    await fs.rm(lockDir, { force: true, recursive: true })
  }
}

const createRetryClock = (onDelay: () => Promise<void> = async () => {}) => {
  let now = 0
  return {
    ...systemClock,
    now: () => now,
    delay: vi.fn(async (ms: number) => {
      now += ms
      await onDelay()
    }),
  }
}

describe('global slot retry policy', () => {
  it.each([0, 125])(
    'bounds persistent transient faults by a %i ms deadline without accumulating error history',
    async (timeoutMs) => {
      const clock = createRetryClock()
      const state = createInProcessRecordingSlotState()
      const failure = Object.assign(new Error('slot still busy'), {
        code: 'EBUSY',
      })
      const openExclusive = vi.fn(async (): Promise<never> => {
        throw failure
      })
      const scheduler = new RecordingSlotScheduler(
        {
          maxGlobalRecordings: 1,
          maxConcurrentRecordings: 1,
          runId: 'test-run',
          recordingStartMode: 'fast-fail',
          recordingStartTimeoutMs: timeoutMs,
        },
        () => {},
        {
          clock,
          inProcessState: state,
          fileSystem: {
            ...nodeFileSystem,
            mkdir: async () => {},
            openExclusive,
          },
        },
      )
      await expect(scheduler.acquire()).rejects.toMatchObject({
        name: 'AggregateError',
        errors: [expect.objectContaining({ cause: failure })],
      })
      expect(clock.now()).toBe(timeoutMs)
      expect(state.activeSlots).toBe(0)
      expect(
        clock.delay.mock.calls.every(([ms]) => ms > 0 && ms <= timeoutMs),
      ).toBe(true)
      if (timeoutMs === 0) {
        expect(openExclusive).toHaveBeenCalledOnce()
        expect(clock.delay).not.toHaveBeenCalled()
      } else {
        expect(openExclusive.mock.calls.length).toBeGreaterThan(1)
      }
    },
  )

  it('returns ordinary contention when an earlier transient fault clears', async () => {
    await withSlotDirectory(async (lockDir) => {
      const slotPath = path.join(lockDir, 'test-run', 'slot-1.lock')
      await fs.mkdir(path.dirname(slotPath))
      await fs.writeFile(slotPath, JSON.stringify({ pid: process.pid }))
      const clock = createRetryClock()
      const openExclusive = vi
        .fn(nodeFileSystem.openExclusive)
        .mockRejectedValueOnce(
          Object.assign(new Error('transient read failure'), {
            code: 'EMFILE',
          }),
        )
      const scheduler = new RecordingSlotScheduler(
        {
          globalRecordingLockDir: lockDir,
          runId: 'test-run',
          maxGlobalRecordings: 1,
          recordingStartMode: 'fast-fail',
          recordingStartTimeoutMs: 125,
        },
        () => {},
        { clock, fileSystem: { ...nodeFileSystem, openExclusive } },
      )
      await expect(scheduler.acquire()).resolves.toBe(false)
      expect(clock.now()).toBe(125)
      expect(scheduler.ownsGlobalRecordingSlot).toBe(false)
      await expect(fs.readFile(slotPath, 'utf8')).resolves.toContain(
        String(process.pid),
      )
    })
  })

  it.each([false, true])(
    'keeps waiting on healthy busy capacity beside a faulty slot (release=%s)',
    async (release) => {
      await withSlotDirectory(async (lockDir) => {
        const busyPath = path.join(lockDir, 'test-run', 'slot-1.lock')
        await fs.mkdir(path.dirname(busyPath))
        await fs.writeFile(busyPath, JSON.stringify({ pid: process.pid }))
        const clock = createRetryClock(async () => {
          if (release) {
            await fs.unlink(busyPath)
          }
        })
        const state = createInProcessRecordingSlotState()
        const openExclusive = vi.fn(async (filePath: string) => {
          if (filePath.endsWith('slot-2.lock')) {
            throw Object.assign(new Error('slot permission denied'), {
              code: 'EACCES',
            })
          }
          return nodeFileSystem.openExclusive(filePath)
        })
        const scheduler = new RecordingSlotScheduler(
          {
            globalRecordingLockDir: lockDir,
            runId: 'test-run',
            maxGlobalRecordings: 2,
            maxConcurrentRecordings: 1,
            recordingStartMode: 'fast-fail',
            recordingStartTimeoutMs: 125,
          },
          () => {},
          {
            clock,
            inProcessState: state,
            fileSystem: { ...nodeFileSystem, openExclusive },
          },
        )
        try {
          if (release) {
            await expect(scheduler.acquire()).resolves.toBe(true)
            expect(scheduler.ownedGlobalRecordingSlotPath).toBe(busyPath)
          } else {
            await expect(scheduler.acquire()).rejects.toBeInstanceOf(
              AggregateError,
            )
            expect(clock.now()).toBe(125)
            expect(state.activeSlots).toBe(0)
            await expect(fs.readFile(busyPath, 'utf8')).resolves.toContain(
              String(process.pid),
            )
          }
          expect(clock.delay).toHaveBeenCalled()
        } finally {
          await scheduler.release()
        }
      })
    },
  )

  it.each(['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'EPERM'])(
    'recovers a transient %s slot error within its deadline',
    async (code) => {
      await withSlotDirectory(async (lockDir) => {
        const clock = createRetryClock()
        const openExclusive = vi
          .fn(nodeFileSystem.openExclusive)
          .mockRejectedValueOnce(
            Object.assign(new Error('temporary slot fault'), { code }),
          )
        const scheduler = new RecordingSlotScheduler(
          {
            globalRecordingLockDir: lockDir,
            runId: 'test-run',
            maxGlobalRecordings: 1,
            recordingStartMode: 'fast-fail',
            recordingStartTimeoutMs: 125,
          },
          () => {},
          {
            clock,
            process: { ...nodeProcess, platform: 'win32' },
            fileSystem: { ...nodeFileSystem, openExclusive },
          },
        )
        try {
          await expect(scheduler.acquire()).resolves.toBe(true)
          expect(openExclusive).toHaveBeenCalledTimes(2)
          expect(clock.delay).toHaveBeenCalledOnce()
        } finally {
          await scheduler.release()
        }
      })
    },
  )

  it.each(['EACCES', 'ENOSPC', 'EPERM', undefined])(
    'fails immediately when all slots have non-retryable %s errors',
    async (code) => {
      const clock = createRetryClock()
      const failure = Object.assign(new Error('permanent fault'), { code })
      const openExclusive = vi.fn(async (): Promise<never> => {
        throw failure
      })
      const scheduler = new RecordingSlotScheduler(
        { maxGlobalRecordings: 1, runId: 'test-run' },
        () => {},
        {
          clock,
          process: { ...nodeProcess, platform: 'linux' },
          fileSystem: {
            ...nodeFileSystem,
            mkdir: async () => {},
            openExclusive,
          },
        },
      )
      await expect(scheduler.acquire()).rejects.toBeInstanceOf(AggregateError)
      expect(openExclusive).toHaveBeenCalledOnce()
      expect(clock.delay).not.toHaveBeenCalled()
    },
  )
})
