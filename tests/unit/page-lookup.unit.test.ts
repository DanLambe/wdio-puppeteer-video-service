import type { Browser, Page } from 'puppeteer-core'
import { describe, expect, it, vi } from 'vitest'
import type { ClockBoundary } from '../../src/service/boundaries.js'
import {
  findActivePage,
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
