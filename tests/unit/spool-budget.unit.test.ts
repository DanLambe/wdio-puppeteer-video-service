import { describe, expect, it, vi } from 'vitest'
import type { DiskSpaceBoundary } from '../../src/service/boundaries.js'
import {
  DEFAULT_SPOOL_LIMITS,
  type SegmentBudget,
  type SegmentBudgetHandlers,
  SpoolBudget,
  type SpoolLimits,
} from '../../src/service/spool-budget.js'

const MIB = 1024 * 1024
const GIB = 1024 * MIB

const LIMITS: SpoolLimits = {
  promoteBytes: 100,
  hardCapBytes: 400,
  promoteFreeBytes: 2_000,
  stopFreeBytes: 500,
  freeCheckIntervalBytes: 50,
}

const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

const createDisk = (free: number | Error = 10_000) => {
  let value = free
  const freeBytes = vi.fn(async (_directory: string): Promise<number> => {
    if (value instanceof Error) {
      throw value
    }
    return value
  })
  const disk: DiskSpaceBoundary = { freeBytes }
  return {
    disk,
    freeBytes,
    set: (next: number | Error) => {
      value = next
    },
  }
}

// A segment whose sink has accepted `size` bytes, which the test can grow.
const startSegment = (
  budget: SpoolBudget,
  handlerOverrides: Partial<SegmentBudgetHandlers> = {},
  directory = '/spool',
) => {
  const state = { size: 0 }
  const segment = budget.beginSegment(directory, () => state.size)
  const handlers = {
    isSpooling: vi.fn(handlerOverrides.isSpooling ?? (() => true)),
    promote: vi.fn(),
    stop: vi.fn(),
  }
  segment.attach(handlers)
  return { handlers, segment, state }
}

describe('default spool limits', () => {
  it('promote at 256 MiB, cap at 1 GiB, with floors of 2 GiB and 512 MiB', () => {
    expect(DEFAULT_SPOOL_LIMITS).toEqual({
      promoteBytes: 256 * MIB,
      hardCapBytes: GIB,
      promoteFreeBytes: 2 * GIB,
      stopFreeBytes: 512 * MIB,
      freeCheckIntervalBytes: 16 * MIB,
    })
  })
})

describe('spool budget thresholds', () => {
  it('lets a segment under every limit spool undisturbed', async () => {
    const { disk } = createDisk()
    const budget = new SpoolBudget(LIMITS, disk)
    const { handlers, segment, state } = startSegment(budget)
    state.size = 99

    expect(segment.check(0)).toBeUndefined()
    await settle()

    expect(handlers.promote).not.toHaveBeenCalled()
    expect(handlers.stop).not.toHaveBeenCalled()
    expect(budget.promoted).toBe(false)
  })

  it('requests promotion once at the promote threshold and promotes later segments', () => {
    const budget = new SpoolBudget(LIMITS, createDisk().disk)
    const { handlers, segment, state } = startSegment(budget)

    state.size = 100
    expect(segment.check(0)).toBeUndefined()
    state.size = 300
    expect(segment.check(0)).toBeUndefined()

    expect(handlers.promote).toHaveBeenCalledOnce()
    expect(budget.promoted).toBe(true)
  })

  it('counts the sealed segments of the recording toward the promote threshold', () => {
    const budget = new SpoolBudget(LIMITS, createDisk().disk)
    // Ten segments of 9 bytes each, every one far under the threshold alone.
    const sealed = Array.from({ length: 10 }, () => {
      const first = startSegment(budget)
      first.state.size = 9
      return first
    })
    expect(
      sealed.every(({ handlers }) => handlers.promote.mock.calls.length === 0),
    ).toBe(true)
    expect(budget.bytes).toBe(90)

    const active = startSegment(budget)
    active.state.size = 10
    active.segment.check(0)
    expect(active.handlers.promote).toHaveBeenCalledOnce()
    expect(budget.bytes).toBe(100)
  })

  it('reaches the promote threshold at the recording total, not per segment', () => {
    const budget = new SpoolBudget(LIMITS, createDisk().disk)
    const first = startSegment(budget)
    first.state.size = 60
    first.segment.check(0)
    expect(first.handlers.promote).not.toHaveBeenCalled()

    const second = startSegment(budget)
    second.state.size = 40
    second.segment.check(0)

    expect(second.handlers.promote).toHaveBeenCalledOnce()
    expect(budget.promoted).toBe(true)
  })

  it('stops at the hard cap, counting sealed segments and what is still queued', () => {
    const budget = new SpoolBudget(LIMITS, createDisk().disk)
    const sealed = startSegment(budget)
    sealed.state.size = 300
    const active = startSegment(budget)
    active.state.size = 50

    // 350 on disk; the queued and reserved bytes must fit in the 50 left.
    expect(active.segment.check(50)).toBeUndefined()
    expect(active.segment.check(51)).toBe(
      "The recording's frame spools reached the disk limit of 400 bytes",
    )
    expect(budget.promoted).toBe(true)
  })

  it('names the cap in mebibytes and gibibytes', () => {
    const budget = new SpoolBudget(DEFAULT_SPOOL_LIMITS, createDisk().disk)
    const { segment, state } = startSegment(budget)
    state.size = GIB
    expect(segment.check(1)).toBe(
      "The recording's frame spools reached the disk limit of 1.0 GiB",
    )
    const small = new SpoolBudget(
      { ...DEFAULT_SPOOL_LIMITS, hardCapBytes: 3 * MIB },
      createDisk().disk,
    )
    const other = startSegment(small)
    other.state.size = 3 * MIB
    expect(other.segment.check(1)).toContain('3.0 MiB')
  })

  it('forgets a released segment: its bytes leave the total and it never decides', () => {
    const budget = new SpoolBudget(LIMITS, createDisk().disk)
    const gone = startSegment(budget)
    gone.state.size = 390
    const active = startSegment(budget)
    active.state.size = 20
    expect(active.segment.check(0)).toBeDefined()

    gone.segment.release()

    expect(budget.bytes).toBe(20)
    expect(active.segment.check(0)).toBeUndefined()
    expect(gone.segment.check(0)).toBeUndefined()
  })

  it('reports the sink byte count of a sealed segment until it is released', () => {
    const budget = new SpoolBudget(LIMITS, createDisk().disk)
    const sealed = startSegment(budget)
    sealed.state.size = 120
    expect(sealed.segment.bytes).toBe(120)
    expect(budget.bytes).toBe(120)
  })
})

describe('spool budget free-space floors', () => {
  it('checks the free space when a segment begins', async () => {
    const { disk, freeBytes } = createDisk()
    const budget = new SpoolBudget(LIMITS, disk)
    const { segment } = startSegment(budget, {}, '/run/spool')

    segment.begin()
    await settle()

    expect(freeBytes).toHaveBeenCalledExactlyOnceWith('/run/spool')
  })

  it('promotes below the upper floor but keeps spooling above the lower one', async () => {
    const { disk } = createDisk(1_000)
    const budget = new SpoolBudget(LIMITS, disk)
    const { handlers, segment } = startSegment(budget)

    segment.begin()
    await settle()

    expect(handlers.promote).toHaveBeenCalledOnce()
    expect(handlers.stop).not.toHaveBeenCalled()
    expect(budget.promoted).toBe(true)
    expect(segment.check(0)).toBeUndefined()
  })

  it('stops a segment that is still spooling below the lower floor', async () => {
    const { disk } = createDisk(400)
    const budget = new SpoolBudget(LIMITS, disk)
    const { handlers, segment } = startSegment(budget)

    segment.begin()
    await settle()

    expect(handlers.promote).toHaveBeenCalledOnce()
    expect(handlers.stop).toHaveBeenCalledExactlyOnceWith(
      'Free disk space for the frame spool fell to 400 bytes, below the floor of 500 bytes',
    )
    expect(segment.check(0)).toContain('Free disk space for the frame spool')
  })

  it('does not stop a segment that is promoting or live, wherever the floor is crossed', async () => {
    const { disk } = createDisk(100)
    const budget = new SpoolBudget(LIMITS, disk)
    const { handlers, segment } = startSegment(budget, {
      isSpooling: () => false,
    })

    segment.begin()
    await settle()

    expect(handlers.promote).toHaveBeenCalledOnce()
    expect(handlers.stop).not.toHaveBeenCalled()
    expect(segment.check(0)).toBeUndefined()
  })

  it('treats a failed check as unknown and never stops the recording', async () => {
    const { disk, freeBytes } = createDisk(new Error('statfs unsupported'))
    const budget = new SpoolBudget(LIMITS, disk)
    const { handlers, segment, state } = startSegment(budget)

    segment.begin()
    await settle()
    state.size = 60
    expect(segment.check(0)).toBeUndefined()
    await settle()

    expect(freeBytes).toHaveBeenCalledTimes(2)
    expect(handlers.promote).not.toHaveBeenCalled()
    expect(handlers.stop).not.toHaveBeenCalled()
    expect(budget.promoted).toBe(false)
  })

  it('treats a free space that is not a number as unknown', async () => {
    const { disk } = createDisk()
    disk.freeBytes = async () => Number.NaN
    const budget = new SpoolBudget(LIMITS, disk)
    const { handlers, segment } = startSegment(budget)

    segment.begin()
    await settle()

    expect(handlers.promote).not.toHaveBeenCalled()
    expect(handlers.stop).not.toHaveBeenCalled()
  })

  it('checks again after each further interval of bytes, not before', async () => {
    const { disk, freeBytes } = createDisk()
    const budget = new SpoolBudget(LIMITS, disk)
    const { segment, state } = startSegment(budget)
    segment.begin()
    await settle()
    expect(freeBytes).toHaveBeenCalledTimes(1)

    state.size = 49
    segment.check(0)
    await settle()
    expect(freeBytes).toHaveBeenCalledTimes(1)

    state.size = 50
    segment.check(0)
    await settle()
    expect(freeBytes).toHaveBeenCalledTimes(2)

    state.size = 99
    segment.check(0)
    await settle()
    expect(freeBytes).toHaveBeenCalledTimes(2)

    state.size = 100
    segment.check(0)
    await settle()
    expect(freeBytes).toHaveBeenCalledTimes(3)
  })

  it('does not start a second check while one is outstanding', async () => {
    let resolve: ((free: number) => void) | undefined
    const freeBytes = vi.fn(
      () =>
        new Promise<number>((done) => {
          resolve = done
        }),
    )
    const budget = new SpoolBudget(LIMITS, { freeBytes })
    const { segment, state } = startSegment(budget)
    segment.begin()
    state.size = 300
    segment.check(0)
    segment.check(0)

    expect(freeBytes).toHaveBeenCalledTimes(1)
    resolve?.(10_000)
    await settle()
    state.size = 350
    segment.check(0)
    expect(freeBytes).toHaveBeenCalledTimes(2)
  })

  it('ignores a check that completes after the segment was released', async () => {
    const { disk, set } = createDisk(100)
    const budget = new SpoolBudget(LIMITS, disk)
    const { handlers, segment } = startSegment(budget)
    segment.begin()
    segment.release()
    set(100)
    await settle()

    expect(handlers.promote).not.toHaveBeenCalled()
    expect(handlers.stop).not.toHaveBeenCalled()
  })

  it('keeps a low reading found before the handlers are attached for the next check', async () => {
    const { disk } = createDisk(100)
    const budget = new SpoolBudget(LIMITS, disk)
    const state = { size: 0 }
    const segment: SegmentBudget = budget.beginSegment(
      '/spool',
      () => state.size,
    )
    segment.begin()
    await settle()

    // Nobody to tell yet; the reading stays and the next check reports it.
    expect(segment.check(0)).toBeUndefined()
    const handlers = { isSpooling: () => true, promote: vi.fn(), stop: vi.fn() }
    segment.attach(handlers)
    expect(segment.check(0)).toContain('Free disk space')
  })
})

describe('sealed spool segments', () => {
  // A segment whose sink count reports how often it is read.
  const startCountedSegment = (budget: SpoolBudget, size: number) => {
    const reads = { count: 0 }
    const segment = budget.beginSegment('/spool', () => {
      reads.count += 1
      return size
    })
    segment.attach({ isSpooling: () => true, promote: vi.fn(), stop: vi.fn() })
    return { reads, segment }
  }

  it('never reads a sealed segment again on the capture path, with the same totals', () => {
    const limits = { ...DEFAULT_SPOOL_LIMITS, hardCapBytes: 100 * 256 + 300 }
    const unsealed = new SpoolBudget(limits, createDisk().disk)
    const sealedBudget = new SpoolBudget(limits, createDisk().disk)
    const old = Array.from({ length: 100 }, () =>
      startCountedSegment(sealedBudget, 256),
    )
    for (let index = 0; index < 100; index += 1) {
      startCountedSegment(unsealed, 256)
    }
    for (const { segment } of old) {
      segment.seal()
    }
    const readsAtSeal = old.reduce((total, { reads }) => total + reads.count, 0)
    expect(readsAtSeal).toBe(100)

    const active = startSegment(sealedBudget)
    const reference = startSegment(unsealed)
    active.state.size = 256
    reference.state.size = 256
    for (let check = 0; check < 1_000; check += 1) {
      expect(active.segment.check(0)).toBe(reference.segment.check(0))
    }

    const readsAfterSeal =
      old.reduce((total, { reads }) => total + reads.count, 0) - readsAtSeal
    expect(readsAfterSeal).toBe(0)
    expect(sealedBudget.bytes).toBe(unsealed.bytes)
    expect(sealedBudget.bytes).toBe(101 * 256)
    // The hard cap is decided on the same total.
    expect(active.segment.check(44)).toBeUndefined()
    expect(active.segment.check(45)).toBe(reference.segment.check(45))
    expect(active.segment.check(45)).toContain('disk limit')
  })

  it('keeps the bytes accepted when sealed, whatever the sink reports later', () => {
    const budget = new SpoolBudget(LIMITS, createDisk().disk)
    const { segment, state } = startSegment(budget)
    state.size = 120
    segment.seal()
    state.size = 999
    segment.seal()

    expect(segment.bytes).toBe(120)
    expect(budget.bytes).toBe(120)
  })

  it('detaches the handlers and decides nothing once sealed', async () => {
    const { disk } = createDisk(100)
    const budget = new SpoolBudget(LIMITS, disk)
    const { handlers, segment, state } = startSegment(budget)
    segment.begin()
    segment.seal()
    // The sample started before the seal resolves after it.
    await settle()
    state.size = 1_000

    expect(segment.check(0)).toBeUndefined()
    expect(handlers.promote).not.toHaveBeenCalled()
    expect(handlers.stop).not.toHaveBeenCalled()
    expect(handlers.isSpooling).not.toHaveBeenCalled()
  })

  it('takes a sealed spool out of the total when it is released', () => {
    const budget = new SpoolBudget(LIMITS, createDisk().disk)
    const sealed = startSegment(budget)
    sealed.state.size = 70
    sealed.segment.seal()
    const active = startSegment(budget)
    active.state.size = 20

    sealed.segment.release()
    sealed.segment.release()

    expect(budget.bytes).toBe(20)
  })

  it('does not count a segment sealed after it was released', () => {
    const budget = new SpoolBudget(LIMITS, createDisk().disk)
    const { segment, state } = startSegment(budget)
    state.size = 70
    segment.release()
    segment.seal()

    expect(budget.bytes).toBe(0)
  })
})
