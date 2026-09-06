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

  start(operation: () => Promise<boolean>): Promise<boolean> {
    if (this.startTask) {
      return this.startTask
    }

    if (
      this.stopTask ||
      this.finalizeTask ||
      this.resetTask ||
      this.currentState === 'recording' ||
      this.currentState === 'stopping' ||
      this.currentState === 'processing'
    ) {
      return Promise.resolve(false)
    }

    this.currentState = 'preparing'
    const task = Promise.resolve()
      .then(operation)
      .then((started) => {
        this.currentState = started ? 'recording' : 'failed'
        return started
      })
      .catch((error: unknown) => {
        this.currentState = 'failed'
        throw error
      })
      .finally(() => {
        this.startTask = undefined
      })
    this.startTask = task
    return task
  }

  stop(operations: RecordingStopOperations): Promise<void> {
    if (this.stopTask) {
      return this.stopTask
    }

    const task = Promise.resolve()
      .then(() => this.runStop(operations))
      .finally(() => {
        this.stopTask = undefined
      })
    this.stopTask = task
    return task
  }

  finalize(operations: RecordingFinalizeOperations): Promise<void> {
    if (this.finalizeTask) {
      return this.finalizeTask
    }

    const task = Promise.resolve()
      .then(() => this.runFinalize(operations))
      .finally(() => {
        this.finalizeTask = undefined
      })
    this.finalizeTask = task
    return task
  }

  reset(operation: AsyncOperation): Promise<void> {
    if (this.resetTask) {
      return this.resetTask
    }

    const task = Promise.resolve()
      .then(operation)
      .finally(() => {
        this.currentState = 'idle'
      })
      .finally(() => {
        this.resetTask = undefined
      })
    this.resetTask = task
    return task
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
    this.currentState = 'stopping'
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
