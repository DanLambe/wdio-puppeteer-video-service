import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  nodeFileSystem,
  nodeProcess,
  systemClock,
} from '../../src/service/boundaries.js'

describe('service runtime boundaries', () => {
  it('delegates clock and microtask operations to Node', async () => {
    vi.useFakeTimers()
    try {
      const timeoutCallback = vi.fn()
      const intervalCallback = vi.fn()
      const microtaskCallback = vi.fn()
      const timeout = systemClock.setTimeout(timeoutCallback, 5)
      const interval = systemClock.setInterval(intervalCallback, 5)
      systemClock.queueMicrotask(microtaskCallback)

      await vi.advanceTimersByTimeAsync(5)
      systemClock.clearTimeout(timeout)
      systemClock.clearInterval(interval)
      const delayTask = systemClock.delay(1)
      await vi.advanceTimersByTimeAsync(1)
      await delayTask

      expect(timeoutCallback).toHaveBeenCalledOnce()
      expect(intervalCallback).toHaveBeenCalledOnce()
      expect(microtaskCallback).toHaveBeenCalledOnce()
      expect(systemClock.now()).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('performs filesystem operations through the injected contract', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-boundary-'))
    const nestedDir = path.join(tempDir, 'nested')
    const filePath = path.join(nestedDir, 'exclusive.txt')
    try {
      await nodeFileSystem.mkdir(nestedDir)
      const handle = await nodeFileSystem.openExclusive(filePath)
      await handle.writeFile('boundary')
      await handle.close()

      await expect(nodeFileSystem.readText(filePath)).resolves.toBe('boundary')
      await expect(nodeFileSystem.stat(filePath)).resolves.toMatchObject({
        mtimeMs: expect.any(Number),
      })
      await nodeFileSystem.unlink(filePath)
      await expect(fs.stat(filePath)).rejects.toThrow()
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('exposes process properties and environment lookup', () => {
    const variableName = 'WDIO_VIDEO_BOUNDARY_TEST'
    const previousValue = process.env[variableName]
    process.env[variableName] = 'configured'
    try {
      expect(nodeProcess.pid).toBe(process.pid)
      expect(nodeProcess.platform).toBe(process.platform)
      expect(nodeProcess.environment(variableName)).toBe('configured')
      expect(nodeProcess.isAlive(process.pid)).toBe(true)
    } finally {
      if (previousValue === undefined) {
        delete process.env[variableName]
      } else {
        process.env[variableName] = previousValue
      }
    }
  })
})
