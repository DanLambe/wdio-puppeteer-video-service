import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForChildProcess } from '../scripts/child-process.js'

const createChildProcess = (): {
  child: ChildProcess
  kill: ReturnType<typeof vi.fn>
} => {
  const kill = vi.fn(() => true)
  const child = Object.assign(new EventEmitter(), {
    kill,
  }) as unknown as ChildProcess
  return { child, kill }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('E2E child process helper', () => {
  it('resolves when the child exits successfully', async () => {
    const { child } = createChildProcess()
    const result = waitForChildProcess(child, (code) => `failed: ${code}`, 100)

    child.emit('close', 0)

    await expect(result).resolves.toBeUndefined()
  })

  it('rejects with the caller failure message for a non-zero exit', async () => {
    const { child } = createChildProcess()
    const result = waitForChildProcess(child, (code) => `failed: ${code}`, 100)

    child.emit('close', 2)

    await expect(result).rejects.toThrow('failed: 2')
  })

  it('kills and rejects a child that exceeds its timeout', async () => {
    vi.useFakeTimers()
    const { child, kill } = createChildProcess()
    const result = waitForChildProcess(child, (code) => `failed: ${code}`, 100)
    const rejection = expect(result).rejects.toThrow(
      'failed: null (timed out after 100ms)',
    )

    await vi.advanceTimersByTimeAsync(100)

    await rejection
    expect(kill).toHaveBeenCalledOnce()
  })

  it('clears the timeout after the child settles', async () => {
    vi.useFakeTimers()
    const { child, kill } = createChildProcess()
    const result = waitForChildProcess(child, (code) => `failed: ${code}`, 100)

    child.emit('close', 0)
    await result
    await vi.advanceTimersByTimeAsync(100)

    expect(kill).not.toHaveBeenCalled()
  })
})
