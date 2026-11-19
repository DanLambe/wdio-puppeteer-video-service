import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ScreencastSpool } from '../../src/service/frame-sink.js'
import {
  createFfmpegArguments,
  LIVE_INPUT,
} from '../../src/service/screencast-arguments.js'
import {
  encodeSpool,
  type SpoolEncodeRunner,
} from '../../src/service/spool-encode.js'
import type { OutputFormat } from '../../src/types.js'

const inputOf = (args: string[]): string | undefined =>
  args[args.indexOf('-i') + 1]

const withoutInput = (args: string[]): string[] => {
  const copy = [...args]
  copy.splice(args.indexOf('-i') + 1, 1)
  return copy
}

describe('shared screencast FFmpeg arguments', () => {
  it.each(['webm', 'mp4'] as const)(
    'differ between a live and a spooled %s encode only in the input',
    (format: OutputFormat) => {
      const options = {
        format,
        outputPath: `segment.${format}`,
        quality: 24,
        scale: 0.5,
      }
      const dimensions = { width: 1600, height: 900 }
      const crop = { x: 20, y: 40, width: 800, height: 400 }
      const live = createFfmpegArguments(options, dimensions, crop)
      const spooled = createFfmpegArguments(
        options,
        dimensions,
        crop,
        'spool.mkv',
      )

      expect(inputOf(live)).toBe(LIVE_INPUT)
      expect(inputOf(spooled)).toBe('spool.mkv')
      // Both read the recorder's Matroska stream.
      expect(spooled[spooled.indexOf('-i') - 1]).toBe('matroska')
      expect(withoutInput(spooled)).toEqual(withoutInput(live))
      expect(live.slice(-2)).toEqual(['-y', `segment.${format}`])
    },
  )

  it('reads the live stream from standard input by default', () => {
    expect(LIVE_INPUT).toBe('pipe:0')
  })
})

const spool: ScreencastSpool = {
  path: 'spool/segment.mkv',
  settings: {
    canvas: { width: 1280, height: 720 },
    crop: { x: 10, y: 20, width: 600, height: 200 },
    format: 'webm',
    quality: 30,
    scale: 1,
  },
}

describe('spool encode', () => {
  it('encodes the spool with the arguments its live encode would have used', async () => {
    const run = vi.fn<SpoolEncodeRunner>(async () => ({
      code: 0,
      diagnostic: '',
      signal: null,
    }))

    await expect(
      encodeSpool(
        { ffmpegPath: 'ffmpeg.exe', outputPath: 'out/segment.webm', spool },
        run,
      ),
    ).resolves.toEqual({ ok: true })

    const outputPath = path.resolve('out/segment.webm')
    expect(run).toHaveBeenCalledExactlyOnceWith({
      args: createFfmpegArguments(
        { format: 'webm', outputPath, quality: 30, scale: 1 },
        spool.settings.canvas,
        spool.settings.crop,
        path.resolve(spool.path),
      ),
      ffmpegPath: 'ffmpeg.exe',
      operation: 'spool encode',
    })
  })

  it('applies the spool’s format, scale and missing crop', async () => {
    const run = vi.fn<SpoolEncodeRunner>(async () => ({
      code: 0,
      diagnostic: '',
      signal: null,
    }))
    const { crop: _crop, ...uncropped } = spool.settings
    await encodeSpool(
      {
        ffmpegPath: 'ffmpeg',
        outputPath: 'segment.mp4',
        spool: {
          path: 'spool.mkv',
          settings: { ...uncropped, format: 'mp4', scale: 0.5 },
        },
      },
      run,
    )
    const args = run.mock.calls[0]?.[0].args ?? []
    expect(args[args.indexOf('-vf') + 1]).toBe(
      "crop='min(1280,iw):min(720,ih):0:0',pad=1280:720:0:0,scale=iw*0.5:-1:flags=lanczos,format=yuv420p",
    )
    expect(args).toEqual(expect.arrayContaining(['-f', 'mp4']))
  })

  it.each([
    [
      { code: 1, diagnostic: 'Invalid data found', signal: null },
      'FFmpeg exited with code 1 while encoding the frame spool: Invalid data found',
    ],
    [
      { code: null, diagnostic: '', signal: 'SIGKILL' as const },
      'FFmpeg was terminated by SIGKILL while encoding the frame spool.',
    ],
  ])(
    'reports a failed encode with its diagnostic: %o',
    async (exit, reason) => {
      await expect(
        encodeSpool(
          { ffmpegPath: 'ffmpeg', outputPath: 'segment.webm', spool },
          async () => exit,
        ),
      ).resolves.toEqual({ ok: false, reason })
    },
  )

  it.each([
    [new Error('spawn ffmpeg ENOENT'), 'spawn ffmpeg ENOENT'],
    ['runner gone', 'runner gone'],
  ])('reports a runner that cannot run FFmpeg: %s', async (error, message) => {
    await expect(
      encodeSpool(
        { ffmpegPath: 'ffmpeg', outputPath: 'segment.webm', spool },
        async () => {
          throw error
        },
      ),
    ).resolves.toEqual({
      ok: false,
      reason: `FFmpeg could not encode the frame spool: ${message}`,
    })
  })
})
