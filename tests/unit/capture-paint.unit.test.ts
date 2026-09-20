import type { CDPSession, Page } from 'puppeteer-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  primeScreencastFrames,
  waitForBrowserToRender,
} from '../../src/service/capture.js'

const createHarness = () => {
  const detach = vi.fn(async () => {})
  const send = vi.fn(async () => ({ data: 'AQ==' }))
  const session = { detach, send } as unknown as CDPSession
  const createCDPSession = vi.fn(async () => session)
  const screenshot = vi.fn(async () => new Uint8Array([1]))
  const setViewport = vi.fn(async () => {})
  const page = {
    createCDPSession,
    screenshot,
    setViewport,
    viewport: () => ({ width: 800, height: 600 }),
  } as unknown as Page
  return {
    createCDPSession,
    detach,
    page,
    screenshot,
    send,
    session,
    setViewport,
  }
}

describe('disposable browser paint requests', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('detaches a timed-out paint request without using the shared screenshot lock', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const pending = Promise.withResolvers<{ data: string }>()
    harness.send.mockReturnValue(pending.promise)
    harness.screenshot.mockImplementation(async () => {
      await pending.promise
      return new Uint8Array([1])
    })

    const rendering = waitForBrowserToRender(harness.page)
    await vi.advanceTimersByTimeAsync(20_000)

    await expect(rendering).resolves.toBe('timed-out')
    expect(harness.screenshot).not.toHaveBeenCalled()
    expect(harness.detach).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    pending.reject(new Error('Target detached after deadline'))
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.detach).toHaveBeenCalledOnce()
  })

  it('uses an unclipped paint command and releases its owned session on success', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    await expect(waitForBrowserToRender(harness.page)).resolves.toBe('rendered')
    expect(harness.send).toHaveBeenCalledExactlyOnceWith(
      'Page.captureScreenshot',
      {
        format: 'jpeg',
        quality: 1,
        fromSurface: true,
        captureBeyondViewport: false,
      },
      { timeout: 20_000 },
    )
    expect(harness.screenshot).not.toHaveBeenCalled()
    expect(harness.detach).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases the session when its paint command fails', async () => {
    const harness = createHarness()
    harness.send.mockRejectedValue(new Error('Target closed'))
    await expect(waitForBrowserToRender(harness.page)).resolves.toBe('failed')
    expect(harness.detach).toHaveBeenCalledOnce()
  })

  it('contains session creation failures without requesting a paint', async () => {
    const harness = createHarness()
    harness.createCDPSession.mockRejectedValue(new Error('Session closed'))
    await expect(waitForBrowserToRender(harness.page)).resolves.toBe('failed')
    expect(harness.send).not.toHaveBeenCalled()
    expect(harness.detach).not.toHaveBeenCalled()
  })

  it('detaches late-created sessions without starting a paint after timeout', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const pending = Promise.withResolvers<CDPSession>()
    harness.createCDPSession.mockReturnValue(pending.promise)
    const rendering = waitForBrowserToRender(harness.page)
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(rendering).resolves.toBe('timed-out')
    expect(harness.detach).not.toHaveBeenCalled()
    pending.resolve(harness.session)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.detach).toHaveBeenCalledOnce()
    expect(harness.send).not.toHaveBeenCalled()
  })

  it('handles a session creation rejection after timeout', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const pending = Promise.withResolvers<CDPSession>()
    harness.createCDPSession.mockReturnValue(pending.promise)
    const rendering = waitForBrowserToRender(harness.page)
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(rendering).resolves.toBe('timed-out')
    pending.reject(new Error('Browser disconnected'))
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.send).not.toHaveBeenCalled()
    expect(harness.detach).not.toHaveBeenCalled()
  })

  it.each(['rejects', 'hangs'])(
    'does not block tests if cleanup %s',
    async (mode) => {
      const harness = createHarness()
      harness.detach.mockImplementation(async () => {
        if (mode === 'rejects') {
          throw new Error('Target already detached')
        }
        await new Promise(() => {})
      })
      await expect(waitForBrowserToRender(harness.page)).resolves.toBe(
        'rendered',
      )
      expect(harness.detach).toHaveBeenCalledOnce()
    },
  )

  it('also detaches a timed-out priming paint and restores the viewport', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.send.mockImplementation(async () => new Promise(() => {}))
    const priming = primeScreencastFrames(harness.page)
    await vi.advanceTimersByTimeAsync(550)
    await expect(priming).resolves.toBe(true)
    expect(harness.screenshot).not.toHaveBeenCalled()
    expect(harness.detach).toHaveBeenCalledOnce()
    expect(harness.send).toHaveBeenCalledWith(
      'Page.captureScreenshot',
      expect.any(Object),
      { timeout: 500 },
    )
    expect(harness.setViewport).toHaveBeenLastCalledWith({
      width: 800,
      height: 600,
    })
    expect(vi.getTimerCount()).toBe(0)
  })
})
