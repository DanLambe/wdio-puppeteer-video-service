export interface BoundedTaskFailure<TTask extends object> {
  readonly error: unknown
  readonly index: number
  readonly task: TTask
}

interface BoundedTaskQueueState<TTask extends object> {
  readonly execute: (task: TTask, index: number) => Promise<void>
  readonly failures: BoundedTaskFailure<TTask>[]
  readonly queue: TTask[]
  nextIndex: number
}

export const drainBoundedTaskQueue = async <TTask extends object>(
  queue: TTask[],
  workerCount: number,
  execute: (task: TTask, index: number) => Promise<void>,
): Promise<readonly BoundedTaskFailure<TTask>[]> => {
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new TypeError('workerCount must be a positive integer')
  }

  const state: BoundedTaskQueueState<TTask> = {
    execute,
    failures: [],
    nextIndex: 0,
    queue,
  }
  const activeWorkerCount = Math.min(workerCount, queue.length)
  await Promise.all(
    Array.from({ length: activeWorkerCount }, async () => {
      await drainTaskQueueWorker(state)
    }),
  )
  return state.failures.sort((left, right) => left.index - right.index)
}

const drainTaskQueueWorker = async <TTask extends object>(
  state: BoundedTaskQueueState<TTask>,
): Promise<void> => {
  for (;;) {
    const task = state.queue.shift()
    if (!task) {
      return
    }

    const index = state.nextIndex
    state.nextIndex += 1
    try {
      await state.execute(task, index)
    } catch (error) {
      state.failures.push({ error, index, task })
    }
  }
}
