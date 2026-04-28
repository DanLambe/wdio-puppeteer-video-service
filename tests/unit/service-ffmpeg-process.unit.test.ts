import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

import WdioPuppeteerVideoService from '../../src/service.js'

class FakeFfmpegProcess extends EventEmitter {
  stderr: PassThrough | null = new PassThrough()
  kill = vi.fn(() => true)
}

describe('WdioPuppeteerVideoService ffmpeg process handling', () => {
  afterEach(() => {
    spawnMock.mockReset()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('_spawnFfmpegProcess hides Windows console windows', () => {
    const process = new FakeFfmpegProcess()
    spawnMock.mockReturnValue(process)
    const service = new WdioPuppeteerVideoService() as unknown as {
      _spawnFfmpegProcess: (
        ffmpegPath: string,
        args: string[],
      ) => FakeFfmpegProcess
    }

    expect(service._spawnFfmpegProcess('ffmpeg', ['-version'])).toBe(process)
    expect(spawnMock).toHaveBeenCalledWith('ffmpeg', ['-version'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
  })

  it('_runFfmpeg resolves once when a process error is followed by close', async () => {
    const process = new FakeFfmpegProcess()
    spawnMock.mockReturnValue(process)
    const service = new WdioPuppeteerVideoService() as unknown as {
      _ffmpegAvailable: boolean
      _log: (level: string, message: string) => void
      _resolvedFfmpegPath: string | undefined
      _runFfmpeg: (args: string[], operation: string) => Promise<boolean>
      _warnMissingFfmpeg: (reason: string) => void
    }
    const warnMissingFfmpeg = vi.fn()
    const warnMessages: string[] = []
    service._ffmpegAvailable = true
    service._resolvedFfmpegPath = 'ffmpeg'
    service._warnMissingFfmpeg = warnMissingFfmpeg
    service._log = (level, message) => {
      if (level === 'warn') {
        warnMessages.push(message)
      }
    }

    const resultPromise = service._runFfmpeg(['-version'], 'probe')
    process.emit('error', new Error('spawn failed'))
    process.emit('close', 1)

    await expect(resultPromise).resolves.toBe(false)
    expect(service._ffmpegAvailable).toBe(false)
    expect(warnMissingFfmpeg).toHaveBeenCalledTimes(1)
    expect(warnMessages).toHaveLength(1)
    expect(warnMessages[0]).toContain('Failed to spawn ffmpeg')
  })

  it('_runFfmpeg includes captured stderr when ffmpeg exits nonzero', async () => {
    const process = new FakeFfmpegProcess()
    spawnMock.mockReturnValue(process)
    const service = new WdioPuppeteerVideoService() as unknown as {
      _ffmpegAvailable: boolean
      _log: (level: string, message: string) => void
      _resolvedFfmpegPath: string | undefined
      _runFfmpeg: (args: string[], operation: string) => Promise<boolean>
    }
    const warnMessages: string[] = []
    service._ffmpegAvailable = true
    service._resolvedFfmpegPath = 'ffmpeg'
    service._log = (level, message) => {
      if (level === 'warn') {
        warnMessages.push(message)
      }
    }

    const resultPromise = service._runFfmpeg(['-i', 'input.webm'], 'merge')
    process.stderr?.write('muxer failed')
    process.emit('close', 1)

    await expect(resultPromise).resolves.toBe(false)
    expect(warnMessages).toHaveLength(1)
    expect(warnMessages[0]).toContain('muxer failed')
  })

  it('_runFfmpeg kills and fails timed out operations', async () => {
    vi.useFakeTimers()
    try {
      const process = new FakeFfmpegProcess()
      spawnMock.mockReturnValue(process)
      const service = new WdioPuppeteerVideoService({
        ffmpegTimeoutMs: 25,
      }) as unknown as {
        _ffmpegAvailable: boolean
        _log: (level: string, message: string) => void
        _resolvedFfmpegPath: string | undefined
        _runFfmpeg: (args: string[], operation: string) => Promise<boolean>
      }
      const warnMessages: string[] = []
      service._ffmpegAvailable = true
      service._resolvedFfmpegPath = 'ffmpeg'
      service._log = (level, message) => {
        if (level === 'warn') {
          warnMessages.push(message)
        }
      }

      const resultPromise = service._runFfmpeg(['-i', 'input.webm'], 'merge')
      await vi.advanceTimersByTimeAsync(25)

      await expect(resultPromise).resolves.toBe(false)
      expect(process.kill).toHaveBeenCalledTimes(1)
      expect(warnMessages).toEqual([
        '[WdioPuppeteerVideoService] ffmpeg merge timed out after 25ms',
      ])

      process.emit('close', 0)
      expect(warnMessages).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
