import type { Page, ScreenRecorder, Viewport } from 'puppeteer-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { systemClock } from '../../src/service/boundaries.js'
import {
  primeScreencastFrames,
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

  it.each(['current', { width: 800, height: 600 }] as const)(
    'adds crop guidance and preserves the cause with viewport %j',
    async (viewport) => {
      const failure = new Error(
        '`crop.width` cannot be larger than the viewport width (800).',
      )
      const setViewport = vi.fn(async (_viewport: Viewport | null) => {})
      const capture = resolveServiceConfiguration({
        capture: { viewport, crop: { x: 0, y: 0, width: 900, height: 400 } },
      }).options.capture

      await expect(
        startScreencast(
          {
            viewport: () => null,
            setViewport,
            screencast: async () => {
              throw failure
            },
          } as unknown as Page,
          { capture, format: 'webm', ffmpegPath: 'ffmpeg.exe' },
        ),
      ).rejects.toMatchObject({
        cause: failure,
        message: expect.stringMatching(/capture\.crop.*capture\.viewport/u),
      })
      if (viewport === 'current') {
        expect(setViewport).not.toHaveBeenCalled()
      } else {
        expect(setViewport).toHaveBeenLastCalledWith(null)
      }
    },
  )

  it('does not misclassify unrelated screencast failures when crop is configured', async () => {
    const failure = new Error('FFmpeg failed to start')
    const capture = resolveServiceConfiguration({
      capture: { crop: { x: 0, y: 0, width: 400, height: 300 } },
    }).options.capture
    await expect(
      startScreencast(
        {
          viewport: () => null,
          screencast: async () => {
            throw failure
          },
        } as unknown as Page,
        { capture, format: 'webm', ffmpegPath: 'ffmpeg.exe' },
      ),
    ).rejects.toBe(failure)
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

  it('evaluates the native browser viewport for frame priming', async () => {
    const setViewport = vi.fn(async () => {})
    const page = {
      setViewport,
      viewport: () => null,
      evaluate: async (callback: () => { width: number; height: number }) => {
        Object.assign(globalThis, { innerWidth: 900, innerHeight: 500 })
        return callback()
      },
    } as unknown as Page
    await primeScreencastFrames(page, { ...systemClock, delay: async () => {} })
    expect(setViewport).toHaveBeenNthCalledWith(1, { width: 901, height: 500 })
    expect(setViewport).toHaveBeenNthCalledWith(2, null)
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
        screenshot: async () => {
          throw new Error('document context destroyed')
        },
      } as unknown as Page,
      { ...systemClock, delay },
    )
    expect(setViewport).toHaveBeenCalledTimes(2)
    expect(delay).toHaveBeenCalledWith(50)
  })

  it('requests one unclipped in-memory paint before restoring the viewport', async () => {
    vi.useFakeTimers()
    const { promise, resolve } = Promise.withResolvers<Uint8Array>()
    const screenshot = vi.fn(async () => promise)
    const setViewport = vi.fn(async (_viewport: Viewport | null) => {})
    const page = {
      viewport: () => ({ width: 800, height: 600 }),
      setViewport,
      screenshot,
    } as unknown as Page
    const priming = primeScreencastFrames(page)
    await vi.advanceTimersByTimeAsync(0)
    expect(setViewport).toHaveBeenCalledTimes(1)
    expect(screenshot).toHaveBeenCalledExactlyOnceWith({
      type: 'jpeg',
      quality: 1,
      captureBeyondViewport: false,
    })
    resolve(new Uint8Array([1]))
    await vi.advanceTimersByTimeAsync(50)
    await priming
    expect(setViewport).toHaveBeenLastCalledWith({ width: 800, height: 600 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds priming when the browser never answers its paint request', async () => {
    vi.useFakeTimers()
    const setViewport = vi.fn(async (_viewport: Viewport | null) => {})
    const { promise, reject } = Promise.withResolvers<void>()
    const page = {
      viewport: () => ({ width: 800, height: 600 }),
      setViewport,
      screenshot: async () => promise,
    } as unknown as Page
    const priming = primeScreencastFrames(page)
    await vi.advanceTimersByTimeAsync(550)
    await priming
    expect(setViewport).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    // A late protocol rejection must remain handled after the Node deadline.
    reject(new Error('target closed after timeout'))
    await vi.advanceTimersByTimeAsync(0)
  })

  it('contains a failed paint request and clears its deadline', async () => {
    vi.useFakeTimers()
    const setViewport = vi.fn(async (_viewport: Viewport | null) => {})
    const priming = primeScreencastFrames({
      viewport: () => ({ width: 800, height: 600 }),
      setViewport,
      screenshot: async () => {
        throw new Error('target closed')
      },
    } as unknown as Page)
    await vi.advanceTimersByTimeAsync(50)
    await priming
    expect(setViewport).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('restores the viewport when the injected warmup clock fails', async () => {
    const setViewport = vi.fn(async (_viewport: Viewport | null) => {})
    const error = new Error('clock interrupted')
    const priming = primeScreencastFrames(
      {
        viewport: () => ({ width: 800, height: 600 }),
        setViewport,
        screenshot: async () => new Uint8Array(),
      } as unknown as Page,
      {
        ...systemClock,
        delay: async () => {
          throw error
        },
      },
    )
    await expect(priming).rejects.toBe(error)
    expect(setViewport).toHaveBeenLastCalledWith({ width: 800, height: 600 })
  })
})
