import type { Page, ScreenRecorder, Viewport } from 'puppeteer-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { systemClock } from '../../src/service/boundaries.js'
import {
  primeScreencastFrames,
  startScreencast,
} from '../../src/service/capture.js'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import { PAGE_MARKER_PROPERTY } from '../../src/service/page-lookup.js'
import WdioPuppeteerVideoService from '../../src/service.js'

interface CaptureServiceProbe {
  _prepareRecordingPage: (browser: unknown) => Promise<unknown>
  _sessionProtocol: string
}

const createRecorder = (): ScreenRecorder => {
  return { id: 'recorder' } as unknown as ScreenRecorder
}

describe('Puppeteer 25 capture controls', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    Reflect.deleteProperty(globalThis, PAGE_MARKER_PROPERTY)
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
    }).options

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
    }).options
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
    }).options

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
    const capture = resolveServiceConfiguration({}).options

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

  it('uses a unique non-enumerable page marker and removes it after lookup', async () => {
    const descriptors: Array<PropertyDescriptor | undefined> = []
    const markerIds: string[] = []
    const page = {
      bringToFront: async () => {},
      evaluate: async (
        callback: (property: string) => unknown,
        property: string,
      ) => {
        descriptors.push(Object.getOwnPropertyDescriptor(globalThis, property))
        return callback(property)
      },
    }
    const execute = async (
      callback: (property: string, id: string) => void,
      property: string,
      id: string,
    ) => {
      markerIds.push(id)
      callback(property, id)
    }
    const browser = {
      capabilities: {
        browserName: 'chrome',
        webSocketUrl: 'ws://localhost/bidi',
      },
      execute,
      getPuppeteer: async () => ({
        connected: true,
        pages: async () => [page],
      }),
      getWindowHandle: async () => 'window-1',
      options: { hostname: 'localhost' },
    }
    const firstService = new WdioPuppeteerVideoService({
      logLevel: 'silent',
    }) as unknown as CaptureServiceProbe
    const secondService = new WdioPuppeteerVideoService({
      logLevel: 'silent',
    }) as unknown as CaptureServiceProbe

    await expect(
      firstService._prepareRecordingPage(browser),
    ).resolves.toBeTruthy()
    await expect(
      secondService._prepareRecordingPage(browser),
    ).resolves.toBeTruthy()

    expect(descriptors).toHaveLength(2)
    expect(
      descriptors.every((descriptor) => descriptor?.enumerable === false),
    ).toBe(true)
    expect(markerIds[0]).not.toBe(markerIds[2])
    expect(Reflect.has(globalThis, PAGE_MARKER_PROPERTY)).toBe(false)
    expect(firstService._sessionProtocol).toBe('bidi+cdp')
  })
})
