import { describe, expect, it, vi } from 'vitest'
import { RecordingLifecycle } from '../../src/service/recording-lifecycle.js'

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, reject, resolve }
}

describe('RecordingLifecycle', () => {
  it('moves through the complete recording state sequence', async () => {
    const lifecycle = new RecordingLifecycle()
    const seenStates = [lifecycle.state]

    await expect(
      lifecycle.start(async () => {
        seenStates.push(lifecycle.state)
        return true
      }),
    ).resolves.toBe(true)
    seenStates.push(lifecycle.state)

    await lifecycle.stop({
      hasWork: () => true,
      stopCapture: async () => {
        seenStates.push(lifecycle.state)
      },
      processCapture: async () => {
        seenStates.push(lifecycle.state)
      },
    })
    seenStates.push(lifecycle.state)

    await lifecycle.reset(async () => {
      seenStates.push(lifecycle.state)
    })
    seenStates.push(lifecycle.state)

    expect(seenStates).toEqual([
      'idle',
      'preparing',
      'recording',
      'stopping',
      'processing',
      'completed',
      'completed',
      'idle',
    ])
  })

  it('deduplicates concurrent starts', async () => {
    const lifecycle = new RecordingLifecycle()
    const deferred = createDeferred<boolean>()
    const startOperation = vi.fn(() => deferred.promise)

    const first = lifecycle.start(startOperation)
    const second = lifecycle.start(startOperation)

    expect(first).toBe(second)
    expect(lifecycle.state).toBe('preparing')
    expect(lifecycle.isBusy).toBe(true)
    deferred.resolve(true)

    await expect(first).resolves.toBe(true)
    expect(startOperation).toHaveBeenCalledOnce()
    expect(lifecycle.state).toBe('recording')
  })

  it('rejects starts while recording, stopping, or processing', async () => {
    const lifecycle = new RecordingLifecycle()
    await lifecycle.start(async () => true)

    await expect(lifecycle.start(async () => true)).resolves.toBe(false)

    const stopDeferred = createDeferred<void>()
    const stopTask = lifecycle.stop({
      hasWork: () => true,
      stopCapture: () => stopDeferred.promise,
      processCapture: async () => {},
    })
    expect(lifecycle.state).toBe('stopping')
    await expect(lifecycle.start(async () => true)).resolves.toBe(false)
    stopDeferred.resolve()
    await stopTask

    const processDeferred = createDeferred<void>()
    const finalizeTask = lifecycle.finalize({
      stopRecording: async () => {},
      processArtifacts: () => processDeferred.promise,
    })
    await Promise.resolve()
    expect(lifecycle.state).toBe('processing')
    await expect(lifecycle.start(async () => true)).resolves.toBe(false)
    processDeferred.resolve()
    await finalizeTask
  })

  it('allows a new segment after completion or failure', async () => {
    const lifecycle = new RecordingLifecycle()
    await lifecycle.start(async () => true)
    await lifecycle.stop({
      hasWork: () => true,
      stopCapture: async () => {},
      processCapture: async () => {},
    })
    await expect(lifecycle.start(async () => true)).resolves.toBe(true)

    lifecycle.fail()
    expect(lifecycle.state).toBe('failed')
    await expect(lifecycle.start(async () => true)).resolves.toBe(true)
  })

  it('moves failed and throwing starts to failed', async () => {
    const lifecycle = new RecordingLifecycle()

    await expect(lifecycle.start(async () => false)).resolves.toBe(false)
    expect(lifecycle.state).toBe('failed')

    await expect(
      lifecycle.start(async () => {
        throw new Error('start failed')
      }),
    ).rejects.toThrow('start failed')
    expect(lifecycle.state).toBe('failed')
  })

  it('waits for preparation before stopping', async () => {
    const lifecycle = new RecordingLifecycle()
    const startDeferred = createDeferred<boolean>()
    let hasWork = false
    const calls: string[] = []

    const startTask = lifecycle.start(async () => {
      const started = await startDeferred.promise
      hasWork = started
      return started
    })
    const stopTask = lifecycle.stop({
      hasWork: () => hasWork,
      stopCapture: async () => {
        calls.push('stop')
      },
      processCapture: async () => {
        calls.push('process')
      },
    })

    startDeferred.resolve(true)
    await Promise.all([startTask, stopTask])

    expect(calls).toEqual(['stop', 'process'])
    expect(lifecycle.state).toBe('completed')
  })

  it('absorbs a rejected preparation while a stop is waiting', async () => {
    const lifecycle = new RecordingLifecycle()
    const startDeferred = createDeferred<boolean>()
    const startTask = lifecycle.start(() => startDeferred.promise)
    const stopCapture = vi.fn(async () => {})
    const stopTask = lifecycle.stop({
      hasWork: () => false,
      stopCapture,
      processCapture: async () => {},
    })

    startDeferred.reject(new Error('target destroyed'))

    await expect(startTask).rejects.toThrow('target destroyed')
    await expect(stopTask).resolves.toBeUndefined()
    expect(stopCapture).not.toHaveBeenCalled()
    expect(lifecycle.state).toBe('failed')
  })

  it('does nothing when stop has no owned work', async () => {
    const lifecycle = new RecordingLifecycle()
    const stopCapture = vi.fn()
    const processCapture = vi.fn()

    await lifecycle.stop({
      hasWork: () => false,
      stopCapture,
      processCapture,
    })

    expect(stopCapture).not.toHaveBeenCalled()
    expect(processCapture).not.toHaveBeenCalled()
    expect(lifecycle.state).toBe('idle')
  })

  it('deduplicates concurrent stops and records stop failures', async () => {
    const lifecycle = new RecordingLifecycle()
    await lifecycle.start(async () => true)
    const deferred = createDeferred<void>()
    const stopCapture = vi.fn(() => deferred.promise)
    const operations = {
      hasWork: () => true,
      stopCapture,
      processCapture: vi.fn(async () => {}),
    }

    const first = lifecycle.stop(operations)
    const second = lifecycle.stop(operations)
    expect(first).toBe(second)
    deferred.reject(new Error('stop failed'))

    await expect(first).rejects.toThrow('stop failed')
    expect(stopCapture).toHaveBeenCalledOnce()
    expect(operations.processCapture).not.toHaveBeenCalled()
    expect(lifecycle.state).toBe('failed')
  })

  it('records processing failures', async () => {
    const lifecycle = new RecordingLifecycle()
    await lifecycle.start(async () => true)

    await expect(
      lifecycle.stop({
        hasWork: () => true,
        stopCapture: async () => {},
        processCapture: async () => {
          throw new Error('processing failed')
        },
      }),
    ).rejects.toThrow('processing failed')
    expect(lifecycle.state).toBe('failed')
  })

  it('deduplicates finalization and preserves the idle state after reset', async () => {
    const lifecycle = new RecordingLifecycle()
    await lifecycle.start(async () => true)
    const deferred = createDeferred<void>()
    const stopRecording = vi.fn(async () => {})
    const processArtifacts = vi.fn(async () => {
      await deferred.promise
      await lifecycle.reset(async () => {})
    })
    const operations = { processArtifacts, stopRecording }

    const first = lifecycle.finalize(operations)
    const second = lifecycle.finalize(operations)
    expect(first).toBe(second)
    deferred.resolve()
    await first

    expect(stopRecording).toHaveBeenCalledOnce()
    expect(processArtifacts).toHaveBeenCalledOnce()
    expect(lifecycle.state).toBe('idle')
  })

  it('moves failed finalization to failed', async () => {
    const lifecycle = new RecordingLifecycle()

    await expect(
      lifecycle.finalize({
        stopRecording: async () => {},
        processArtifacts: async () => {
          throw new Error('merge failed')
        },
      }),
    ).rejects.toThrow('merge failed')
    expect(lifecycle.state).toBe('failed')
  })

  it('deduplicates resets and returns to idle even when cleanup fails', async () => {
    const lifecycle = new RecordingLifecycle()
    lifecycle.fail()
    const deferred = createDeferred<void>()
    const resetOperation = vi.fn(() => deferred.promise)

    const first = lifecycle.reset(resetOperation)
    const second = lifecycle.reset(resetOperation)
    expect(first).toBe(second)
    deferred.reject(new Error('release failed'))

    await expect(first).rejects.toThrow('release failed')
    expect(resetOperation).toHaveBeenCalledOnce()
    expect(lifecycle.state).toBe('idle')
    expect(lifecycle.isBusy).toBe(false)
  })
})
