export const RECORDING_LIFECYCLE_STATES = [
  'idle',
  'preparing',
  'recording',
  'stopping',
  'processing',
  'completed',
  'failed',
] as const

export type RecordingLifecycleState =
  (typeof RECORDING_LIFECYCLE_STATES)[number]

export interface RecordingStopOperations {
  hasWork: () => boolean
  processCapture: () => Promise<void>
  stopCapture: () => Promise<void>
}

export interface RecordingFinalizeOperations {
  processArtifacts: () => Promise<void>
  stopRecording: () => Promise<void>
}

type AsyncOperation = () => Promise<void>

export class RecordingLifecycle {
  private currentState: RecordingLifecycleState = 'idle'
  private finalizeTask: Promise<void> | undefined
  private resetTask: Promise<void> | undefined
  private startTask: Promise<boolean> | undefined
  private stopTask: Promise<void> | undefined

  get state(): RecordingLifecycleState {
    return this.currentState
  }

  get isBusy(): boolean {
    return (
      this.currentState === 'preparing' ||
      this.currentState === 'recording' ||
      this.currentState === 'stopping' ||
      this.currentState === 'processing'
    )
  }

  start(operation: () => Promise<boolean>): Promise<boolean> {
    if (this.startTask) {
      return this.startTask
    }

    if (
      this.currentState === 'recording' ||
      this.currentState === 'stopping' ||
      this.currentState === 'processing'
    ) {
      return Promise.resolve(false)
    }

    this.currentState = 'preparing'
    const task = operation()
      .then((started) => {
        this.currentState = started ? 'recording' : 'failed'
        return started
      })
      .catch((error: unknown) => {
        this.currentState = 'failed'
        throw error
      })
      .finally(() => {
        if (this.startTask === task) {
          this.startTask = undefined
        }
      })
    this.startTask = task
    return task
  }

  stop(operations: RecordingStopOperations): Promise<void> {
    if (this.stopTask) {
      return this.stopTask
    }

    const task = this.runStop(operations).finally(() => {
      if (this.stopTask === task) {
        this.stopTask = undefined
      }
    })
    this.stopTask = task
    return task
  }

  finalize(operations: RecordingFinalizeOperations): Promise<void> {
    if (this.finalizeTask) {
      return this.finalizeTask
    }

    const task = this.runFinalize(operations).finally(() => {
      if (this.finalizeTask === task) {
        this.finalizeTask = undefined
      }
    })
    this.finalizeTask = task
    return task
  }

  reset(operation: AsyncOperation): Promise<void> {
    if (this.resetTask) {
      return this.resetTask
    }

    const task = operation()
      .finally(() => {
        this.currentState = 'idle'
      })
      .finally(() => {
        if (this.resetTask === task) {
          this.resetTask = undefined
        }
      })
    this.resetTask = task
    return task
  }

  fail(): void {
    this.currentState = 'failed'
  }

  private async runStop(operations: RecordingStopOperations): Promise<void> {
    if (this.startTask) {
      await this.startTask.catch(() => false)
    }

    if (!operations.hasWork()) {
      return
    }

    this.currentState = 'stopping'
    try {
      await operations.stopCapture()
      this.currentState = 'processing'
      await operations.processCapture()
      this.currentState = 'completed'
    } catch (error) {
      this.currentState = 'failed'
      throw error
    }
  }

  private async runFinalize(
    operations: RecordingFinalizeOperations,
  ): Promise<void> {
    try {
      await operations.stopRecording()
      this.currentState = 'processing'
      await operations.processArtifacts()
      if (!this.isIdle()) {
        this.currentState = 'completed'
      }
    } catch (error) {
      this.currentState = 'failed'
      throw error
    }
  }

  private isIdle(): boolean {
    return this.currentState === 'idle'
  }
}
