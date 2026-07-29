import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { parseFfmpegProbeOutput, probeMediaFile } from '../utils/media-probe.js'

class FakeMediaProbeProcess extends EventEmitter {
  stderr = new PassThrough()
  kill = vi.fn(() => true)
}

const validProbeOutput = `
Input #0, matroska,webm, from 'fixture.webm':
  Duration: 00:00:01.25, start: 0.000000, bitrate: 100 kb/s
  Stream #0:0: Video: vp9 (Profile 0), yuv420p, 1280x720, 30 fps
frame=   38 fps=0.0 q=-0.0 Lsize=N/A time=00:00:01.25 bitrate=N/A speed=8x
`

describe('media probe', () => {
  it('parses container, codec, dimensions, duration, and frame count', () => {
    expect(parseFfmpegProbeOutput(validProbeOutput)).toEqual({
      container: 'webm',
      codec: 'vp9',
      width: 1280,
      height: 720,
      durationSeconds: 1.25,
      frameCount: 38,
    })
  })

  it('derives raw WebM duration from the decoded timeline', () => {
    const rawWebmOutput = validProbeOutput
      .replace('Duration: 00:00:01.25', 'Duration: N/A')
      .replace('time=00:00:01.25', 'time=00:00:01.10')

    expect(parseFfmpegProbeOutput(rawWebmOutput).durationSeconds).toBe(1.1)
  })

  it('returns decoded media details when FFmpeg succeeds', async () => {
    const process = new FakeMediaProbeProcess()
    const result = probeMediaFile('ffmpeg', 'fixture.webm', {
      spawnProcess: () => process as unknown as ChildProcess,
    })

    process.stderr.write(validProbeOutput)
    process.emit('close', 0)

    await expect(result).resolves.toMatchObject({
      container: 'webm',
      codec: 'vp9',
      frameCount: 38,
    })
  })

  it('rejects corrupt media when FFmpeg cannot decode it', async () => {
    const process = new FakeMediaProbeProcess()
    const result = probeMediaFile('ffmpeg', 'corrupt.webm', {
      spawnProcess: () => process as unknown as ChildProcess,
    })

    process.stderr.write('Invalid data found when processing input')
    process.emit('close', 1)

    await expect(result).rejects.toThrow('Media decode failed for corrupt.webm')
  })

  it('kills media decoding after the configured timeout', async () => {
    vi.useFakeTimers()
    try {
      const process = new FakeMediaProbeProcess()
      const result = probeMediaFile('ffmpeg', 'slow.webm', {
        timeoutMs: 100,
        spawnProcess: () => process as unknown as ChildProcess,
      })
      const rejection = expect(result).rejects.toThrow(
        'Media decode timed out for slow.webm after 100ms',
      )

      await vi.advanceTimersByTimeAsync(100)

      await rejection
      expect(process.kill).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
