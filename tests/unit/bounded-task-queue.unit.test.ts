import { describe, expect, it, vi } from 'vitest'
import { drainBoundedTaskQueue } from '../../src/service/bounded-task-queue.js'

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

describe('bounded task queue', () => {
  it('runs one worker sequentially and drains the source queue', async () => {
    const first = createDeferred<void>()
    const queue = [{ id: 1 }, { id: 2 }]
    const started: number[] = []
    const draining = drainBoundedTaskQueue(queue, 1, async (task) => {
      started.push(task.id)
      if (task.id === 1) {
        await first.promise
      }
    })

    await vi.waitFor(() => {
      expect(started).toEqual([1])
    })
    expect(queue).toEqual([{ id: 2 }])
    first.resolve()

    await expect(draining).resolves.toEqual([])
    expect(started).toEqual([1, 2])
    expect(queue).toEqual([])
  })

  it('bounds concurrent work and starts the next queued task after capacity frees', async () => {
    const gates = new Map([
      [1, createDeferred<void>()],
      [2, createDeferred<void>()],
      [3, createDeferred<void>()],
    ])
    const queue = [{ id: 1 }, { id: 2 }, { id: 3 }]
    const started: number[] = []
    let active = 0
    let maximumActive = 0
    const draining = drainBoundedTaskQueue(queue, 2, async (task) => {
      started.push(task.id)
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await gates.get(task.id)?.promise
      active -= 1
    })

    await vi.waitFor(() => {
      expect(started).toEqual([1, 2])
    })
    expect(queue).toEqual([{ id: 3 }])
    gates.get(2)?.resolve()
    await vi.waitFor(() => {
      expect(started).toEqual([1, 2, 3])
    })
    gates.get(1)?.resolve()
    gates.get(3)?.resolve()

    await expect(draining).resolves.toEqual([])
    expect(maximumActive).toBe(2)
    expect(queue).toEqual([])
  })

  it('settles every task and reports failures in enqueue order', async () => {
    const first = createDeferred<void>()
    const queue = [{ id: 1 }, { id: 2 }, { id: 3 }]
    const started: number[] = []
    const draining = drainBoundedTaskQueue(queue, 2, async (task) => {
      started.push(task.id)
      if (task.id === 1) {
        await first.promise
        throw new Error('first queued failure')
      }
      if (task.id === 2) {
        throw new Error('second queued failure')
      }
    })

    await vi.waitFor(() => {
      expect(started).toEqual([1, 2, 3])
    })
    first.resolve()
    const failures = await draining

    expect(failures.map((failure) => failure.index)).toEqual([0, 1])
    expect(failures.map((failure) => (failure.error as Error).message)).toEqual(
      ['first queued failure', 'second queued failure'],
    )
    expect(queue).toEqual([])
  })

  it('rejects invalid worker counts and handles an empty queue', async () => {
    await expect(drainBoundedTaskQueue([], 0, async () => {})).rejects.toThrow(
      'workerCount must be a positive integer',
    )
    await expect(
      drainBoundedTaskQueue([], 1.5, async () => {}),
    ).rejects.toThrow('workerCount must be a positive integer')
    await expect(drainBoundedTaskQueue([], 1, async () => {})).resolves.toEqual(
      [],
    )
  })
})
