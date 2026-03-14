import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getFfmpegCandidates,
  probeDirectMp4Support,
  resolveAvailableFfmpegPath,
} from '../../src/service/ffmpeg.js'

class FakeProbeProcess extends EventEmitter {
  stderr: PassThrough | null = new PassThrough()
  kill = vi.fn(() => true)
}

describe('ffmpeg helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('deduplicates ffmpeg candidates while preserving priority order', () => {
    const candidates = getFfmpegCandidates(
      '  /custom/ffmpeg  ',
      ' /env/ffmpeg ',
    )

    expect(candidates[0]).toBe('/custom/ffmpeg')
    expect(candidates[1]).toBe('/env/ffmpeg')
    expect(candidates).toContain('ffmpeg')
    expect(new Set(candidates).size).toBe(candidates.length)
  })

  it('returns the first available ffmpeg candidate', async () => {
    const isExecutable = vi.fn(async (candidate: string) => {
      return candidate === '/second/ffmpeg'
    })

    const resolvedPath = await resolveAvailableFfmpegPath(
      ['/first/ffmpeg', '/second/ffmpeg', '/third/ffmpeg'],
      isExecutable,
    )

    expect(resolvedPath).toBe('/second/ffmpeg')
    expect(isExecutable).toHaveBeenCalledTimes(2)
    expect(isExecutable).toHaveBeenNthCalledWith(1, '/first/ffmpeg')
    expect(isExecutable).toHaveBeenNthCalledWith(2, '/second/ffmpeg')
  })

  it('returns undefined when no ffmpeg candidate is executable', async () => {
    const resolvedPath = await resolveAvailableFfmpegPath(
      ['/first/ffmpeg', '/second/ffmpeg'],
      async () => false,
    )

    expect(resolvedPath).toBeUndefined()
  })

  it('reports direct MP4 support when the probe exits cleanly', async () => {
    const probeProcess = new FakeProbeProcess()
    const supportPromise = probeDirectMp4Support('/custom/ffmpeg', {
      spawnProcess: () => probeProcess,
    })

    probeProcess.emit('close', 0)

    await expect(supportPromise).resolves.toBe(true)
    expect(probeProcess.kill).not.toHaveBeenCalled()
  })

  it('logs probe failure details when direct MP4 support is unavailable', async () => {
    const probeProcess = new FakeProbeProcess()
    const onProbeFailure = vi.fn()
    const supportPromise = probeDirectMp4Support('/custom/ffmpeg', {
      onProbeFailure,
      spawnProcess: () => probeProcess,
    })

    probeProcess.stderr?.write('muxer failed')
    probeProcess.emit('close', 1)

    await expect(supportPromise).resolves.toBe(false)
    expect(onProbeFailure).toHaveBeenCalledWith('muxer failed')
  })

  it('fails the direct MP4 probe when it times out', async () => {
    vi.useFakeTimers()
    try {
      const probeProcess = new FakeProbeProcess()
      const supportPromise = probeDirectMp4Support('/custom/ffmpeg', {
        spawnProcess: () => probeProcess,
      })

      await vi.runAllTimersAsync()

      await expect(supportPromise).resolves.toBe(false)
      expect(probeProcess.kill).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails the direct MP4 probe when the probe process emits an error', async () => {
    const probeProcess = new FakeProbeProcess()
    const onProbeFailure = vi.fn()
    const supportPromise = probeDirectMp4Support('/custom/ffmpeg', {
      onProbeFailure,
      spawnProcess: () => probeProcess,
    })

    probeProcess.emit('error', new Error('spawn failed'))

    await expect(supportPromise).resolves.toBe(false)
    expect(onProbeFailure).not.toHaveBeenCalled()
  })

  it('does not report probe failure details when stderr is empty', async () => {
    const probeProcess = new FakeProbeProcess()
    const onProbeFailure = vi.fn()
    const supportPromise = probeDirectMp4Support('/custom/ffmpeg', {
      onProbeFailure,
      spawnProcess: () => probeProcess,
    })

    probeProcess.emit('close', 1)

    await expect(supportPromise).resolves.toBe(false)
    expect(onProbeFailure).not.toHaveBeenCalled()
  })

  it('caps captured probe stderr to the final 8192 characters', async () => {
    const probeProcess = new FakeProbeProcess()
    const onProbeFailure = vi.fn()
    const supportPromise = probeDirectMp4Support('/custom/ffmpeg', {
      onProbeFailure,
      spawnProcess: () => probeProcess,
    })

    probeProcess.stderr?.write('a'.repeat(9000))
    probeProcess.emit('close', 1)

    await expect(supportPromise).resolves.toBe(false)
    expect(onProbeFailure).toHaveBeenCalledTimes(1)
    expect(onProbeFailure.mock.calls[0]?.[0]).toHaveLength(8192)
  })

  it('handles probe processes without a stderr stream', async () => {
    const probeProcess = new FakeProbeProcess()
    probeProcess.stderr = null

    const supportPromise = probeDirectMp4Support('/custom/ffmpeg', {
      spawnProcess: () => probeProcess,
    })

    probeProcess.emit('close', 1)

    await expect(supportPromise).resolves.toBe(false)
  })
})
