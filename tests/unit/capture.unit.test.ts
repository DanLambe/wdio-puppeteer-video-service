import type { Page, ScreenRecorder, Viewport } from 'puppeteer-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { systemClock } from '../../src/service/boundaries.js'
import {
  primeScreencastFrames,
  resolveCaptureDimensions,
  startScreencast,
} from '../../src/service/capture.js'
import { resolveServiceConfiguration } from '../../src/service/options.js'

const createRecorder = (): ScreenRecorder => {
  return { id: 'recorder' } as unknown as ScreenRecorder
}

describe('Puppeteer screencast capture controls', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('passes supported options directly and restores an explicit viewport', async () => {
    const recorder = createRecorder()
    const originalViewport: Viewport = { width: 1365, height: 768 }
    const setViewport = vi.fn(async (_viewport: Viewport | null) => {})
    const screencast = vi.fn(async () => recorder)
    const capture = resolveServiceConfiguration({
      capture: {
        viewport: { width: 1280, height: 720 },
        fps: 24,
        quality: 18,
        scale: 0.5,
        speed: 1.5,
        crop: { x: 10, y: 20, width: 1000, height: 600 },
      },
    }).options.capture

    await expect(
      startScreencast(
        {
          screencast,
          setViewport,
          viewport: () => originalViewport,
        } as unknown as Page,
        { capture, format: 'webm', ffmpegPath: 'ffmpeg.exe' },
      ),
    ).resolves.toBe(recorder)

    expect(setViewport).toHaveBeenNthCalledWith(1, {
      width: 1280,
      height: 720,
    })
    expect(screencast).toHaveBeenCalledWith({
      crop: { x: 10, y: 20, width: 1000, height: 600 },
      ffmpegPath: 'ffmpeg.exe',
      format: 'webm',
      fps: 24,
      quality: 18,
      scale: 0.5,
      speed: 1.5,
    })
    expect(setViewport).toHaveBeenNthCalledWith(2, originalViewport)
    expect(screencast.mock.invocationCallOrder[0]).toBeLessThan(
      setViewport.mock.invocationCallOrder[1] ?? Number.MAX_SAFE_INTEGER,
    )
  })

  it('restores native viewport mode when screencast initialization fails', async () => {
    const setViewport = vi.fn(async (_viewport: Viewport | null) => {})
    const capture = resolveServiceConfiguration({
      capture: { viewport: { width: 800, height: 600 } },
    }).options.capture
    const page = {
      screencast: async () => {
        throw new Error('capture failed')
      },
      setViewport,
      viewport: () => null,
    } as unknown as Page

    await expect(
      startScreencast(page, {
        capture,
        format: 'webm',
        ffmpegPath: 'ffmpeg.exe',
      }),
    ).rejects.toThrow('capture failed')
    expect(setViewport).toHaveBeenLastCalledWith(null)
  })

  it('reports viewport restoration failures without discarding the recorder', async () => {
    const recorder = createRecorder()
    const restoreError = new Error('target closed during restore')
    const onViewportRestoreError = vi.fn()
    const setViewport = vi
      .fn<(_viewport: Viewport | null) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(restoreError)
    const capture = resolveServiceConfiguration({
      capture: { viewport: { width: 800, height: 600 } },
    }).options.capture

    await expect(
      startScreencast(
        {
          screencast: async () => recorder,
          setViewport,
          viewport: () => null,
        } as unknown as Page,
        {
          capture,
          format: 'webm',
          ffmpegPath: 'ffmpeg.exe',
          onViewportRestoreError,
        },
      ),
    ).resolves.toBe(recorder)
    expect(onViewportRestoreError).toHaveBeenCalledWith(restoreError)
  })

  it('does not emulate a viewport when capture.viewport is current', async () => {
    const recorder = createRecorder()
    const setViewport = vi.fn(async (_viewport: Viewport | null) => {})
    const capture = resolveServiceConfiguration({}).options.capture

    await startScreencast(
      {
        screencast: async () => recorder,
        setViewport,
        viewport: () => null,
      } as unknown as Page,
      { capture, format: 'webm', ffmpegPath: 'ffmpeg.exe' },
    )

    expect(setViewport).not.toHaveBeenCalled()
  })

  it('resolves scaled crop dimensions for manifest metadata', async () => {
    const capture = resolveServiceConfiguration({
      capture: {
        viewport: { width: 1280, height: 720 },
        crop: { x: 10, y: 20, width: 800, height: 400 },
        scale: 0.5,
      },
    }).options.capture

    await expect(
      resolveCaptureDimensions(
        { viewport: () => null } as unknown as Page,
        capture,
      ),
    ).resolves.toEqual({ width: 400, height: 200 })
  })

  it('reads native viewport dimensions and handles unavailable dimensions', async () => {
    const capture = resolveServiceConfiguration({}).options.capture
    await expect(
      resolveCaptureDimensions(
        {
          viewport: () => null,
          evaluate: async () => ({ width: 1024, height: 640 }),
        } as unknown as Page,
        capture,
      ),
    ).resolves.toEqual({ width: 1024, height: 640 })
    await expect(
      resolveCaptureDimensions(
        {
          viewport: () => null,
          evaluate: async () => ({ width: 0, height: 0 }),
        } as unknown as Page,
        capture,
      ),
    ).resolves.toBeUndefined()
  })

  it('evaluates native browser dimensions through the page callback', async () => {
    const capture = resolveServiceConfiguration({}).options.capture
    const page = {
      viewport: () => null,
      evaluate: async (callback: () => { width: number; height: number }) => {
        Object.assign(globalThis, { innerWidth: 900, innerHeight: 500 })
        return callback()
      },
    } as unknown as Page
    await expect(resolveCaptureDimensions(page, capture)).resolves.toEqual({
      width: 900,
      height: 500,
    })
    Reflect.deleteProperty(globalThis, 'innerWidth')
    Reflect.deleteProperty(globalThis, 'innerHeight')
  })

  it('primes a static native viewport and returns to native viewport mode', async () => {
    vi.useFakeTimers()
    const setViewport = vi.fn(async (_viewport: Viewport | null) => {})
    const priming = primeScreencastFrames({
      evaluate: async () => ({ width: 1024, height: 640 }),
      setViewport,
      viewport: () => null,
    } as unknown as Page)

    await vi.advanceTimersByTimeAsync(50)
    await priming

    expect(setViewport).toHaveBeenNthCalledWith(1, {
      height: 640,
      width: 1025,
    })
    expect(setViewport).toHaveBeenNthCalledWith(2, null)
  })

  it('skips priming when the active viewport cannot be read', async () => {
    const setViewport = vi.fn(async (_viewport: Viewport | null) => {})
    const delay = vi.fn(async (_milliseconds: number) => {})

    await primeScreencastFrames(
      {
        evaluate: async () => {
          throw new Error('target closed')
        },
        setViewport,
        viewport: () => null,
      } as unknown as Page,
      { ...systemClock, delay },
    )

    expect(setViewport).not.toHaveBeenCalled()
    expect(delay).not.toHaveBeenCalled()
  })

  it('contains best-effort failures while priming frames', async () => {
    const setViewport = vi.fn(async () => {
      throw new Error('target closed')
    })
    const delay = vi.fn(async () => {})
    await primeScreencastFrames(
      {
        viewport: () => ({ width: 800, height: 600 }),
        setViewport,
      } as unknown as Page,
      { ...systemClock, delay },
    )
    expect(setViewport).toHaveBeenCalledTimes(2)
    expect(delay).toHaveBeenCalledWith(50)
  })
})
