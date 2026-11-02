import type { Browser, Page } from 'puppeteer-core'
import { describe, expect, it, vi } from 'vitest'
import type { ClockBoundary } from '../../src/service/boundaries.js'
import {
  findActivePage,
  findPageByTargetId,
  findPageWithId,
  PAGE_MARKER_PROPERTY,
} from '../../src/service/page-lookup.js'

const createPage = (marker: string | Error): Page =>
  ({
    evaluate: async () => {
      if (marker instanceof Error) {
        throw marker
      }
      return marker
    },
  }) as unknown as Page

const createClock = (): { clock: ClockBoundary; delays: number[] } => {
  let now = 0
  const delays: number[] = []
  const clock: ClockBoundary = {
    clearInterval: () => {},
    clearTimeout: () => {},
    delay: async (milliseconds) => {
      delays.push(milliseconds)
      now += milliseconds
    },
    now: () => now,
    queueMicrotask,
    setInterval: () => ({}) as NodeJS.Timeout,
    setTimeout: () => ({}) as NodeJS.Timeout,
  }
  return { clock, delays }
}

describe('Puppeteer page lookup', () => {
  it('returns undefined when no page has the requested marker', async () => {
    await expect(
      findPageWithId([createPage('one'), createPage('two')], 'target'),
    ).resolves.toBeUndefined()
  })

  it('skips inaccessible pages and returns the first matching marker', async () => {
    const matchingPage = createPage('target')

    await expect(
      findPageWithId(
        [
          createPage(new Error('target closed')),
          createPage('other'),
          matchingPage,
        ],
        'target',
      ),
    ).resolves.toBe(matchingPage)
  })

  it('reads the page marker through the Puppeteer evaluation callback', async () => {
    const globalMarker = globalThis as Record<string, unknown>
    const previousMarker = globalMarker[PAGE_MARKER_PROPERTY]
    globalMarker[PAGE_MARKER_PROPERTY] = 'target'
    try {
      const page = {
        evaluate: async (
          callback: (property: string) => unknown,
          property: string,
        ) => callback(property),
      } as unknown as Page

      await expect(findPageWithId([page], 'target')).resolves.toBe(page)
    } finally {
      if (previousMarker === undefined) {
        delete globalMarker[PAGE_MARKER_PROPERTY]
      } else {
        globalMarker[PAGE_MARKER_PROPERTY] = previousMarker
      }
    }
  })

  it('polls through the injected clock until the page appears', async () => {
    const matchingPage = createPage('target')
    const pages = vi
      .fn<() => Promise<Page[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([matchingPage])
    const { clock, delays } = createClock()

    await expect(
      findActivePage({ pages } as Pick<Browser, 'pages'>, 'target', {
        clock,
        pollIntervalMs: 10,
        timeoutMs: 50,
      }),
    ).resolves.toBe(matchingPage)
    expect(pages).toHaveBeenCalledTimes(2)
    expect(delays).toEqual([10])
  })

  it('treats page enumeration failures as a closing browser and times out', async () => {
    const pages = vi.fn<() => Promise<Page[]>>().mockRejectedValue(new Error())
    const { clock } = createClock()

    await expect(
      findActivePage({ pages } as Pick<Browser, 'pages'>, 'target', {
        clock,
        pollIntervalMs: 10,
        timeoutMs: 20,
      }),
    ).resolves.toBeUndefined()
    expect(pages).toHaveBeenCalledTimes(2)
  })

  it('does not enumerate pages when the timeout budget is zero', async () => {
    const pages = vi.fn<() => Promise<Page[]>>().mockResolvedValue([])
    const { clock } = createClock()

    await expect(
      findActivePage({ pages } as Pick<Browser, 'pages'>, 'target', {
        clock,
        timeoutMs: 0,
      }),
    ).resolves.toBeUndefined()
    expect(pages).not.toHaveBeenCalled()
  })
})

describe('Puppeteer page lookup by CDP target id', () => {
  const createTargetPage = (
    targetId: string | 'hang-session' | 'hang-info',
  ) => {
    const detach = vi.fn(async () => {})
    const send = vi.fn(async () =>
      targetId === 'hang-info'
        ? new Promise(() => {})
        : { targetInfo: { targetId } },
    )
    const createCDPSession = vi.fn(async () =>
      targetId === 'hang-session' ? new Promise(() => {}) : { detach, send },
    )
    return {
      detach,
      page: { createCDPSession } as unknown as Page,
      createCDPSession,
      send,
    }
  }

  // Timers fire at once, so a CDP request that never answers times out.
  const createTimerClock = (): ClockBoundary => {
    const { clock } = createClock()
    return {
      ...clock,
      setTimeout: (callback: () => void) => {
        queueMicrotask(callback)
        return { unref: () => {} } as unknown as NodeJS.Timeout
      },
    }
  }

  it('finds the page whose target id is the browsing context id', async () => {
    const first = createTargetPage('tab-a')
    const second = createTargetPage('tab-b')
    const browser = { pages: async () => [first.page, second.page] }

    await expect(
      findPageByTargetId(browser, 'tab-b', { clock: createTimerClock() }),
    ).resolves.toBe(second.page)
    // The id of a page is read once.
    await findPageByTargetId(browser, 'tab-b', { clock: createTimerClock() })
    expect(second.createCDPSession).toHaveBeenCalledOnce()
    expect(second.detach).toHaveBeenCalledOnce()
  })

  it('bounds CDP requests that never answer and keeps looking', async () => {
    const hangingSession = createTargetPage('hang-session')
    const hangingInfo = createTargetPage('hang-info')
    const match = createTargetPage('tab-c')
    const browser = {
      pages: async () => [hangingSession.page, hangingInfo.page, match.page],
    }

    await expect(
      findPageByTargetId(browser, 'tab-c', { clock: createTimerClock() }),
    ).resolves.toBe(match.page)
    expect(hangingInfo.detach).toHaveBeenCalledOnce()
  })

  it('detaches a session that attaches after its deadline', async () => {
    let attach: ((session: unknown) => void) | undefined
    const detach = vi.fn(async () => {})
    const page = {
      createCDPSession: () =>
        new Promise((resolve) => {
          attach = resolve
        }),
    } as unknown as Page
    const { clock } = createClock()
    let now = 0
    const lookup = findPageByTargetId({ pages: async () => [page] }, 'tab-d', {
      clock: {
        ...clock,
        delay: async (milliseconds) => {
          now += milliseconds
        },
        now: () => now,
        setTimeout: (callback: () => void) => {
          queueMicrotask(callback)
          return {} as NodeJS.Timeout
        },
      },
      timeoutMs: 1,
    })

    await expect(lookup).resolves.toBeUndefined()
    attach?.({ detach })
    await vi.waitFor(() => expect(detach).toHaveBeenCalled())
  })

  // Timers fire once pending work has run, and move the clock to their due
  // time, so a test can read how long a lookup would have taken.
  const createVirtualClock = () => {
    const { clock } = createClock()
    let now = 0
    const virtual: ClockBoundary = {
      ...clock,
      clearTimeout: (timer) => {
        clearImmediate(timer as unknown as NodeJS.Immediate)
      },
      delay: async (milliseconds) => {
        now += milliseconds
      },
      now: () => now,
      setTimeout: (callback: () => void, milliseconds: number) => {
        const due = now + milliseconds
        const timer = setImmediate(() => {
          now = Math.max(now, due)
          callback()
        })
        return timer as unknown as NodeJS.Timeout
      },
    }
    return virtual
  }
  const never = new Promise<never>(() => {})

  it('stops listing pages at its deadline', async () => {
    const clock = createVirtualClock()

    await expect(
      findPageByTargetId({ pages: () => never }, 'tab-f', {
        clock,
        timeoutMs: 50,
      }),
    ).resolves.toBeUndefined()
    expect(clock.now()).toBe(50)
  })

  it('shares one deadline across pages that never attach', async () => {
    const clock = createVirtualClock()
    const stalled = Array.from(
      { length: 3 },
      () => ({ createCDPSession: () => never }) as unknown as Page,
    )

    await expect(
      findPageByTargetId({ pages: async () => stalled }, 'tab-g', {
        clock,
        timeoutMs: 50,
        pollIntervalMs: 1,
      }),
    ).resolves.toBeUndefined()
    expect(clock.now()).toBe(50)
  })

  it('returns without waiting for a session to detach, after its request', async () => {
    const calls: string[] = []
    const page = {
      createCDPSession: async () => ({
        send: async () => {
          calls.push('send')
          return { targetInfo: { targetId: 'tab-h' } }
        },
        detach: () => {
          calls.push('detach')
          return never
        },
      }),
    } as unknown as Page

    await expect(
      findPageByTargetId({ pages: async () => [page] }, 'tab-h', {
        clock: createVirtualClock(),
        timeoutMs: 20,
      }),
    ).resolves.toBe(page)
    await vi.waitFor(() => expect(calls).toEqual(['send', 'detach']))
  })

  it('bounds a marker search by one deadline', async () => {
    const stalledMarkers = createVirtualClock()
    const stalled = { evaluate: () => never } as unknown as Page
    await expect(
      findActivePage({ pages: async () => [stalled, stalled] }, 'marker', {
        clock: stalledMarkers,
        timeoutMs: 50,
        pollIntervalMs: 1,
      }),
    ).resolves.toBeUndefined()
    expect(stalledMarkers.now()).toBe(50)

    const stalledPages = createVirtualClock()
    await expect(
      findActivePage({ pages: () => never }, 'marker', {
        clock: stalledPages,
        timeoutMs: 50,
      }),
    ).resolves.toBeUndefined()
    expect(stalledPages.now()).toBe(50)
  })

  it('gives up after its deadline and survives a closing browser', async () => {
    const { clock } = createClock()

    await expect(
      findPageByTargetId(
        { pages: async () => Promise.reject(new Error('closed')) },
        'tab-e',
        { clock, timeoutMs: 100, pollIntervalMs: 50 },
      ),
    ).resolves.toBeUndefined()
  })
})
