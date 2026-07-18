import type { Browser, Page } from 'puppeteer-core'
import { type ClockBoundary, systemClock } from './boundaries.js'
import { ACTIVE_PAGE_POLL_MS, ACTIVE_PAGE_TIMEOUT_MS } from './constants.js'

export interface PageLookupOptions {
  clock?: ClockBoundary
  pollIntervalMs?: number
  timeoutMs?: number
}

export const findPageWithId = async (
  pages: Page[],
  targetId: string,
): Promise<Page | undefined> => {
  for (const page of pages) {
    try {
      const id = await page.evaluate(() => {
        const win = globalThis as unknown as { _wdio_video_id?: string }
        return win._wdio_video_id
      })
      if (id === targetId) {
        return page
      }
    } catch {
      // Access can fail while a page is navigating or closing.
    }
  }

  return undefined
}

export const findActivePage = async (
  browser: Pick<Browser, 'pages'>,
  targetId: string,
  options: PageLookupOptions = {},
): Promise<Page | undefined> => {
  const clock = options.clock ?? systemClock
  const timeoutMs = options.timeoutMs ?? ACTIVE_PAGE_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? ACTIVE_PAGE_POLL_MS
  const startedAt = clock.now()

  while (clock.now() - startedAt < timeoutMs) {
    const pages = await browser
      .pages()
      .catch(() => [] /* browser may be closing */)
    const page = await findPageWithId(pages, targetId)
    if (page) {
      return page
    }
    await clock.delay(pollIntervalMs)
  }

  return undefined
}
