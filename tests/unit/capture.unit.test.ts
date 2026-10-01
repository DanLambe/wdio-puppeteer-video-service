import type { CDPSession, Page, Viewport } from 'puppeteer-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ClockBoundary,
  systemClock,
} from '../../src/service/boundaries.js'
import {
  BROWSER_RENDER_TIMEOUT_MS,
  primeScreencastFrames,
  startScreencast,
  waitForBrowserToRender,
} from '../../src/service/capture.js'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import type {
  ScreencastRecorder,
  ScreencastRecorderOptions,
} from '../../src/service/screencast-recorder.js'

const createRecorder = (): ScreencastRecorder => {
  return { id: 'recorder' } as unknown as ScreencastRecorder
}

const createPaintSession = (send: () => Promise<unknown>) => ({
  createCDPSession: async () =>
    ({ send, detach: async () => {} }) as unknown as CDPSession,
})

const fakeTimerClock = (): ClockBoundary => ({
  ...systemClock,
  // Keep the hold and paint deadlines on the same controlled clock.
  delay: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
})

describe('Puppeteer screencast capture controls', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('passes supported options directly and restores an explicit viewport', async () => {
    const recorder = createRecorder()
    const originalViewport: Viewport = { width: 1365, height: 768 }
    const setViewport = vi.fn(async (_viewport: Viewport | null) => {})
    const record = vi.fn(
      async (_page: Page, _options: ScreencastRecorderOptions) => recorder,
    )
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
    const page = {
      setViewport,
      viewport: () => originalViewport,
    } as unknown as Page

    await expect(
      startScreencast(
        page,
        { capture, format: 'webm', ffmpegPath: 'ffmpeg.exe' },
        record,
      ),
    ).resolves.toBe(recorder)

    expect(setViewport).toHaveBeenNthCalledWith(1, {
      width: 1280,
      height: 720,
    })
    expect(record).toHaveBeenCalledWith(page, {
      crop: { x: 10, y: 20, width: 1000, height: 600 },
      ffmpegPath: 'ffmpeg.exe',
      format: 'webm',
      fps: 24,
      quality: 18,
      scale: 0.5,
      speed: 1.5,
    })
    expect(setViewport).toHaveBeenNthCalledWith(2, originalViewport)
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(
      setViewport.mock.invocationCallOrder[1] ?? Number.MAX_SAFE_INTEGER,
    )
  })

  it('restores native viewport mode when screencast initialization fails', async () => {
    const setViewport = vi.fn(async (_viewport: Viewport | null) => {})
    const capture = resolveServiceConfiguration({
      capture: { viewport: { width: 800, height: 600 } },
    }).options.capture
    const page = { setViewport, viewport: () => null } as unknown as Page

    await expect(
      startScreencast(
        page,
        { capture, format: 'webm', ffmpegPath: 'ffmpeg.exe' },
        async () => {
          throw new Error('capture failed')
        },
      ),
    ).rejects.toThrow('capture failed')
    expect(setViewport).toHaveBeenLastCalledWith(null)
  })

  it('awaits viewport restoration after a partially applied resize rejects', async () => {
    const restored = Promise.withResolvers<void>()
    const setViewport = vi
      .fn()
      .mockRejectedValueOnce(new Error('resize rejected'))
      .mockReturnValueOnce(restored.promise)
    const capture = resolveServiceConfiguration({
      capture: { viewport: { width: 800, height: 600 } },
    }).options.capture
    const record = vi.fn()
    let settled = false
    const starting = startScreencast(
      { setViewport, viewport: () => null } as unknown as Page,
      { capture, format: 'webm', ffmpegPath: 'ffmpeg' },
      record,
    ).catch((error: unknown) => {
      settled = true
      return error
    })
    await vi.waitFor(() => expect(setViewport).toHaveBeenLastCalledWith(null))
    expect(settled).toBe(false)
    expect(record).not.toHaveBeenCalled()
    restored.resolve()
    expect(await starting).toMatchObject({ message: 'resize rejected' })
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
        { setViewport, viewport: () => null } as unknown as Page,
        {
          capture,
          format: 'webm',
          ffmpegPath: 'ffmpeg.exe',
          onViewportRestoreError,
        },
        async () => recorder,
      ),
    ).resolves.toBe(recorder)
    expect(onViewportRestoreError).toHaveBeenCalledWith(restoreError)
  })

  // Chrome's screencast can stop emitting frames after a viewport change it
  // never sees painted, even across the next navigation; without frame
  // priming, nothing else paints after this restore.
  describe('restored-surface paint after an explicit viewport', () => {
    const explicitViewport = resolveServiceConfiguration({
      capture: { viewport: { width: 960, height: 600 }, framePriming: false },
    }).options.capture

    const createPaintingPage = (screenshot: () => Promise<unknown>) => {
      const order: string[] = []
      const detach = vi.fn(async () => {
        order.push('detach')
      })
      const send = vi.fn(async (method: string) => {
        order.push(method)
        return screenshot()
      })
      const page = {
        createCDPSession: vi.fn(async () => {
          order.push('paint-session')
          return { send, detach } as unknown as CDPSession
        }),
        setViewport: vi.fn(async (viewport: Viewport | null) => {
          order.push(viewport ? 'resize' : 'restore')
        }),
        viewport: () => null,
      }
      return { detach, order, page, send }
    }

    it('paints the restored surface before handing over the recorder', async () => {
      const recorder = createRecorder()
      const painted = Promise.withResolvers<void>()
      const { detach, order, page, send } = createPaintingPage(
        () => painted.promise,
      )
      let started = false
      const starting = startScreencast(
        page as unknown as Page,
        { capture: explicitViewport, format: 'webm', ffmpegPath: 'ffmpeg' },
        async () => {
          order.push('record')
          return recorder
        },
      ).then((value) => {
        started = true
        return value
      })

      await vi.waitFor(() => expect(send).toHaveBeenCalled())
      expect(started).toBe(false)
      painted.resolve()
      await expect(starting).resolves.toBe(recorder)
      expect(order).toEqual([
        'resize',
        'record',
        'restore',
        'paint-session',
        'Page.captureScreenshot',
        'detach',
      ])
      // The same disposable, unclipped paint priming uses.
      expect(send).toHaveBeenCalledWith(
        'Page.captureScreenshot',
        {
          format: 'jpeg',
          quality: 1,
          fromSurface: true,
          captureBeyondViewport: false,
        },
        { timeout: 500 },
      )
      expect(detach).toHaveBeenCalledOnce()
    })

    it('bounds an unresponsive paint on the injected clock and releases it', async () => {
      vi.useFakeTimers()
      const recorder = createRecorder()
      const { detach, page } = createPaintingPage(() => new Promise(() => {}))
      let started = false
      const starting = startScreencast(
        page as unknown as Page,
        {
          capture: explicitViewport,
          clock: fakeTimerClock(),
          format: 'webm',
          ffmpegPath: 'ffmpeg',
        },
        async () => recorder,
      ).then((value) => {
        started = true
        return value
      })

      await vi.advanceTimersByTimeAsync(499)
      expect(started).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(starting).resolves.toBe(recorder)
      expect(detach).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    })

    it.each([
      ['the viewport was left as it was', 'current', true],
      ['the screencast failed to start', 'explicit', false],
    ] as const)('does not paint when %s', async (_label, viewport, starts) => {
      const { page } = createPaintingPage(async () => undefined)
      const capture =
        viewport === 'current'
          ? resolveServiceConfiguration({
              capture: { viewport: 'current', framePriming: false },
            }).options.capture
          : explicitViewport
      const starting = startScreencast(
        page as unknown as Page,
        { capture, format: 'webm', ffmpegPath: 'ffmpeg' },
        async () => {
          if (!starts) {
            throw new Error('screencast failed')
          }
          return createRecorder()
        },
      )

      if (starts) {
        await expect(starting).resolves.toBeDefined()
      } else {
        await expect(starting).rejects.toThrow('screencast failed')
        expect(page.setViewport).toHaveBeenLastCalledWith(null)
      }
      expect(page.createCDPSession).not.toHaveBeenCalled()
    })
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
          { viewport: () => null, setViewport } as unknown as Page,
          { capture, format: 'webm', ffmpegPath: 'ffmpeg.exe' },
          async () => {
            throw failure
          },
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
        { viewport: () => null } as unknown as Page,
        { capture, format: 'webm', ffmpegPath: 'ffmpeg.exe' },
        async () => {
          throw failure
        },
      ),
    ).rejects.toBe(failure)
  })

  it('does not emulate a viewport when capture.viewport is current', async () => {
    const recorder = createRecorder()
    const setViewport = vi.fn(async (_viewport: Viewport | null) => {})
    const capture = resolveServiceConfiguration({}).options.capture

    await startScreencast(
      { setViewport, viewport: () => null } as unknown as Page,
      { capture, format: 'webm', ffmpegPath: 'ffmpeg.exe' },
      async () => recorder,
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
        ...createPaintSession(async () => {
          throw new Error('document context destroyed')
        }),
      } as unknown as Page,
      { ...systemClock, delay },
    )
    expect(setViewport).toHaveBeenCalledTimes(2)
    expect(delay).toHaveBeenCalledWith(50)
  })

  it('requests unclipped in-memory paints before and after restoring the viewport', async () => {
    vi.useFakeTimers()
    const { promise, resolve } = Promise.withResolvers<Uint8Array>()
    const screenshot = vi.fn(async () => promise)
    const setViewport = vi.fn(async (_viewport: Viewport | null) => {})
    const page = {
      viewport: () => ({ width: 800, height: 600 }),
      setViewport,
      ...createPaintSession(screenshot),
    } as unknown as Page
    const priming = primeScreencastFrames(page)
    await vi.advanceTimersByTimeAsync(0)
    expect(setViewport).toHaveBeenCalledTimes(1)
    expect(screenshot).toHaveBeenCalledExactlyOnceWith(
      'Page.captureScreenshot',
      {
        format: 'jpeg',
        quality: 1,
        fromSurface: true,
        captureBeyondViewport: false,
      },
      { timeout: 500 },
    )
    resolve(new Uint8Array([1]))
    await vi.advanceTimersByTimeAsync(50)
    await priming
    expect(setViewport).toHaveBeenLastCalledWith({ width: 800, height: 600 })
    expect(screenshot).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds priming when the browser never answers its paint request', async () => {
    vi.useFakeTimers()
    const setViewport = vi.fn(async (_viewport: Viewport | null) => {})
    const { promise, reject } = Promise.withResolvers<void>()
    const page = {
      viewport: () => ({ width: 800, height: 600 }),
      setViewport,
      ...createPaintSession(async () => promise),
    } as unknown as Page
    const priming = primeScreencastFrames(page, fakeTimerClock())
    await vi.advanceTimersByTimeAsync(1_050)
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
      ...createPaintSession(async () => {
        throw new Error('target closed')
      }),
    } as unknown as Page)
    await vi.advanceTimersByTimeAsync(50)
    await priming
    expect(setViewport).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('awaits a restored-surface paint even when temporary viewport frames have arrived', async () => {
    vi.useFakeTimers()
    const restoredPaint = Promise.withResolvers<void>()
    const detachFirst = vi.fn(async () => {})
    const detachRestored = vi.fn(async () => {})
    const setViewport = vi.fn(async () => {})
    const screenshot = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(restoredPaint.promise)
    const createCDPSession = vi
      .fn()
      .mockResolvedValueOnce({ send: screenshot, detach: detachFirst })
      .mockResolvedValueOnce({ send: screenshot, detach: detachRestored })
    let ready = false
    const priming = primeScreencastFrames(
      {
        viewport: () => null,
        evaluate: async () => ({ width: 1280, height: 720 }),
        setViewport,
        createCDPSession,
      } as unknown as Page,
      fakeTimerClock(),
      { frameCount: 2 },
    ).then((result) => {
      ready = true
      return result
    })
    await vi.advanceTimersByTimeAsync(50)
    expect(setViewport).toHaveBeenLastCalledWith(null)
    expect(screenshot).toHaveBeenCalledTimes(2)
    expect(ready).toBe(false)
    expect(detachFirst).toHaveBeenCalledOnce()
    expect(detachRestored).not.toHaveBeenCalled()
    restoredPaint.resolve()
    await expect(priming).resolves.toBe(true)
    expect(detachRestored).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds and detaches an unresponsive restored-surface paint without another resize', async () => {
    vi.useFakeTimers()
    const restoredPaint = Promise.withResolvers<void>()
    const detach = vi.fn(async () => {})
    const setViewport = vi.fn(async () => {})
    const send = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(restoredPaint.promise)
    const priming = primeScreencastFrames(
      {
        viewport: () => ({ width: 800, height: 600 }),
        setViewport,
        createCDPSession: async () => ({ send, detach }),
      } as unknown as Page,
      fakeTimerClock(),
      { frameCount: 2 },
    )
    await vi.advanceTimersByTimeAsync(550)
    await expect(priming).resolves.toBe(true)
    expect(detach).toHaveBeenCalledTimes(2)
    expect(setViewport).toHaveBeenCalledTimes(2)
    expect(setViewport).toHaveBeenLastCalledWith({ width: 800, height: 600 })
    expect(vi.getTimerCount()).toBe(0)
    restoredPaint.reject(new Error('late target closure'))
    await vi.advanceTimersByTimeAsync(0)
    expect(detach).toHaveBeenCalledTimes(2)
    expect(setViewport).toHaveBeenCalledTimes(2)
  })

  it('restores the viewport when the injected warmup clock fails', async () => {
    const setViewport = vi.fn(async (_viewport: Viewport | null) => {})
    const error = new Error('clock interrupted')
    const priming = primeScreencastFrames(
      {
        viewport: () => ({ width: 800, height: 600 }),
        setViewport,
        ...createPaintSession(async () => new Uint8Array()),
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

const createClock = (
  onDelay: (milliseconds: number) => number | undefined = () => undefined,
): { clock: ClockBoundary; delays: number[] } => {
  let now = 0
  const delays: number[] = []
  const clock: ClockBoundary = {
    clearInterval: () => {},
    clearTimeout: () => {},
    delay: async (milliseconds) => {
      delays.push(milliseconds)
      // A callback may report extra time the awaited work took.
      now += milliseconds + (onDelay(milliseconds) ?? 0)
    },
    now: () => now,
    queueMicrotask,
    setInterval: () => ({}) as NodeJS.Timeout,
    setTimeout: () => ({}) as NodeJS.Timeout,
  }
  return { clock, delays }
}

// A page whose recorder has already received the screencast's initial frame.
// The callback decides which warmups produce another, which is how a tab that
// has just been activated is modelled: its early frames never arrive.
const createFramePage = (
  onWarmup: (warmup: number, frames: { frameCount: number }) => void,
): { frames: { frameCount: number }; page: Page; warmups: () => number } => {
  const frames = { frameCount: 1 }
  let warmups = 0
  const page = {
    ...createPaintSession(async () => new Uint8Array()),
    setViewport: vi.fn(async (viewport: Viewport | null) => {
      if (viewport?.width === 801) {
        warmups += 1
        onWarmup(warmups, frames)
      }
    }),
    viewport: () => ({ width: 800, height: 600 }),
  } as unknown as Page
  return { frames, page, warmups: () => warmups }
}

describe('screencast frame recovery', () => {
  it('does not prime again when the first warmup produced a frame', async () => {
    const harness = createFramePage((_warmup, frames) => {
      frames.frameCount += 1
    })
    const { clock, delays } = createClock()

    await expect(
      primeScreencastFrames(harness.page, clock, harness.frames),
    ).resolves.toBe(true)
    expect(harness.warmups()).toBe(1)
    expect(delays).toEqual([50])
  })

  it('primes again when a just-activated tab swallows the first warmup', async () => {
    // The regression: the screencast delivers its initial frame, then drops
    // every frame the first warmup produces. A static page never repaints, so
    // without a second warmup the recording shows only that first frame.
    const harness = createFramePage((warmup, frames) => {
      if (warmup === 2) {
        frames.frameCount += 1
      }
    })
    const { clock, delays } = createClock()

    await expect(
      primeScreencastFrames(harness.page, clock, harness.frames),
    ).resolves.toBe(true)
    expect(harness.warmups()).toBe(2)
    expect(delays).toEqual([50, 100, 50])
  })

  it('waits for an in-flight frame instead of priming again', async () => {
    const harness = createFramePage(() => {})
    const { clock } = createClock((milliseconds) => {
      // The restore frame lands during the settle wait.
      if (milliseconds === 100) {
        harness.frames.frameCount += 1
      }
      return undefined
    })

    await expect(
      primeScreencastFrames(harness.page, clock, harness.frames),
    ).resolves.toBe(true)
    expect(harness.warmups()).toBe(1)
  })

  it('gives up within its budget when the screencast never recovers', async () => {
    const harness = createFramePage(() => {})
    const { clock, delays } = createClock()

    await expect(
      primeScreencastFrames(harness.page, clock, harness.frames),
    ).resolves.toBe(false)
    const elapsed = delays.reduce((total, milliseconds) => total + milliseconds)
    // One warmup, then 100 ms settle plus a 50 ms warmup per retry until the
    // 1,500 ms recovery budget is spent.
    expect(harness.warmups()).toBe(11)
    expect(elapsed).toBe(50 + 1_500)
    // Every warmup restores the viewport it bumped.
    expect(vi.mocked(harness.page.setViewport)).toHaveBeenLastCalledWith({
      width: 800,
      height: 600,
    })
  })

  it('does not start another warmup once the recovery deadline has passed', async () => {
    const harness = createFramePage(() => {})
    // Each warmup's paint takes 60 ms longer than its hold, so a settle wait
    // eventually ends exactly at the deadline.
    const { clock, delays } = createClock((milliseconds) =>
      milliseconds === 50 ? 60 : undefined,
    )

    await expect(
      primeScreencastFrames(harness.page, clock, harness.frames),
    ).resolves.toBe(false)
    // Warmups end at 110 ms, then every 210 ms; the eighth settle wait is cut
    // to the 30 ms left before the 1,610 ms deadline and no warmup follows it.
    expect(delays.at(-1)).toBe(30)
    expect(harness.warmups()).toBe(8)
  })

  it('primes once without verification when no frame source is available', async () => {
    const harness = createFramePage(() => {})
    const { clock } = createClock()

    await expect(primeScreencastFrames(harness.page, clock)).resolves.toBe(true)
    expect(harness.warmups()).toBe(1)
  })
})

describe('waiting for a just-launched browser to render', () => {
  const createTimeoutClock = () => {
    let expire: (() => void) | undefined
    const timeouts: number[] = []
    const clearTimeout = vi.fn()
    const clock: ClockBoundary = {
      ...systemClock,
      clearTimeout,
      setTimeout: (callback, milliseconds) => {
        timeouts.push(milliseconds)
        expire = callback
        return { unref: () => {} } as unknown as NodeJS.Timeout
      },
    }
    return { clearTimeout, clock, expire: () => expire?.(), timeouts }
  }

  it('resolves once a screenshot shows the browser has rendered', async () => {
    const { clearTimeout, clock, timeouts } = createTimeoutClock()
    const screenshot = vi.fn(async () => new Uint8Array())

    await expect(
      waitForBrowserToRender(
        createPaintSession(screenshot) as unknown as Page,
        clock,
      ),
    ).resolves.toBe('rendered')
    expect(screenshot).toHaveBeenCalledWith(
      'Page.captureScreenshot',
      {
        format: 'jpeg',
        quality: 1,
        fromSurface: true,
        captureBeyondViewport: false,
      },
      { timeout: 20_000 },
    )
    expect(timeouts).toEqual([20_000])
    expect(clearTimeout).toHaveBeenCalledOnce()
  })

  it('does not wait out a screenshot that fails', async () => {
    const { clock } = createTimeoutClock()
    const screenshot = vi.fn(async () => {
      throw new Error('Target closed')
    })

    await expect(
      waitForBrowserToRender(
        createPaintSession(screenshot) as unknown as Page,
        clock,
      ),
    ).resolves.toBe('failed')
  })

  it('stops waiting for a browser that draws nothing', async () => {
    const { clock, expire } = createTimeoutClock()
    const page = createPaintSession(() => new Promise(() => {}))

    const waiting = waitForBrowserToRender(page as unknown as Page, clock)
    expire()

    await expect(waiting).resolves.toBe('timed-out')
    expect(BROWSER_RENDER_TIMEOUT_MS).toBe(20_000)
  })
})
