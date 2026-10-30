import type { Browser, CDPSession, Page } from 'puppeteer-core'
import { type ClockBoundary, systemClock } from './boundaries.js'
import { ACTIVE_PAGE_POLL_MS, ACTIVE_PAGE_TIMEOUT_MS } from './constants.js'

export const PAGE_MARKER_PROPERTY = '__wdioPuppeteerVideoServicePageMarker__'

export interface PageLookupOptions {
  clock?: ClockBoundary
  pollIntervalMs?: number
  timeoutMs?: number
}

const readMarker = async (
  page: Page,
  markerProperty: string,
): Promise<unknown> => {
  try {
    return await page.evaluate((property) => {
      return Reflect.get(globalThis, property)
    }, markerProperty)
  } catch {
    // Access can fail while a page is navigating or closing.
    return undefined
  }
}

export const findPageWithId = async (
  pages: Page[],
  targetId: string,
  markerProperty: string = PAGE_MARKER_PROPERTY,
): Promise<Page | undefined> => {
  for (const page of pages) {
    if ((await readMarker(page, markerProperty)) === targetId) {
      return page
    }
  }

  return undefined
}

// Bounds each CDP request of a lookup, so one page that never answers leaves
// time to ask the others before the lookup's deadline.
export const TARGET_INFO_TIMEOUT_MS = 1000

// A Puppeteer page's target never changes, so its id is read once.
const targetIds = new WeakMap<Page, string>()

/** Settles with the operation's value, or undefined once `deadline` passes. */
export const beforeDeadline = async <T>(
  operation: Promise<T>,
  clock: ClockBoundary,
  deadline: number,
): Promise<T | undefined> => {
  const remaining = deadline - clock.now()
  if (remaining <= 0) {
    operation.catch(() => undefined)
    return undefined
  }
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<undefined>((resolve) => {
    timer = clock.setTimeout(() => resolve(undefined), remaining)
    timer.unref?.()
  })
  try {
    return await Promise.race([operation, timedOut])
  } finally {
    if (timer) {
      clock.clearTimeout(timer)
    }
  }
}

// Detaching is cleanup: it is never awaited, so it cannot hold the lookup.
const detachLater = (session: Promise<CDPSession>): void => {
  void session.then((attached) => attached.detach()).catch(() => undefined)
}

const readTargetId = async (
  page: Page,
  clock: ClockBoundary,
  lookupDeadline: number,
): Promise<string | undefined> => {
  const cached = targetIds.get(page)
  if (cached) {
    return cached
  }
  const deadline = Math.min(
    lookupDeadline,
    clock.now() + TARGET_INFO_TIMEOUT_MS,
  )
  const pendingSession = page.createCDPSession()
  const session = await beforeDeadline(pendingSession, clock, deadline)
  if (!session) {
    // A session that attaches after the deadline is detached when it does.
    detachLater(pendingSession)
    return undefined
  }
  try {
    const info = await beforeDeadline(
      session.send('Target.getTargetInfo'),
      clock,
      deadline,
    )
    if (!info) {
      return undefined
    }
    targetIds.set(page, info.targetInfo.targetId)
    return info.targetInfo.targetId
  } finally {
    // Runs once the answer arrived or the deadline passed.
    detachLater(Promise.resolve(session))
  }
}

/**
 * Finds the page of a WebDriver BiDi top-level browsing context. Chromium's
 * BiDi implementation uses the CDP target id as the context id.
 *
 * Listing pages, attaching to them, reading their targets and waiting between
 * attempts all share one deadline, `timeoutMs` after the call.
 */
export const findPageByTargetId = async (
  browser: Pick<Browser, 'pages'>,
  targetId: string,
  options: PageLookupOptions = {},
): Promise<Page | undefined> => {
  const clock = options.clock ?? systemClock
  const timeoutMs = options.timeoutMs ?? ACTIVE_PAGE_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? ACTIVE_PAGE_POLL_MS
  const deadline = clock.now() + timeoutMs

  while (clock.now() < deadline) {
    const pages = await beforeDeadline(
      browser.pages().catch(() => [] /* browser may be closing */),
      clock,
      deadline,
    )
    for (const page of pages ?? []) {
      if (clock.now() >= deadline) {
        return undefined
      }
      const id = await readTargetId(page, clock, deadline).catch(
        () => undefined,
      )
      if (id === targetId) {
        return page
      }
    }
    const remaining = deadline - clock.now()
    if (remaining > 0) {
      await clock.delay(Math.min(pollIntervalMs, remaining))
    }
  }

  return undefined
}

/**
 * Finds the page carrying `markerId`. Listing pages, reading each page's marker
 * and waiting between attempts all share one deadline, `timeoutMs` after the
 * call.
 */
export const findActivePage = async (
  browser: Pick<Browser, 'pages'>,
  markerId: string,
  options: PageLookupOptions = {},
): Promise<Page | undefined> => {
  const clock = options.clock ?? systemClock
  const timeoutMs = options.timeoutMs ?? ACTIVE_PAGE_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? ACTIVE_PAGE_POLL_MS
  const deadline = clock.now() + timeoutMs

  while (clock.now() < deadline) {
    const pages = await beforeDeadline(
      browser.pages().catch(() => [] /* browser may be closing */),
      clock,
      deadline,
    )
    for (const page of pages ?? []) {
      const marker = await beforeDeadline(
        readMarker(page, PAGE_MARKER_PROPERTY),
        clock,
        deadline,
      )
      if (marker === markerId) {
        return page
      }
      if (clock.now() >= deadline) {
        return undefined
      }
    }
    const remaining = deadline - clock.now()
    if (remaining > 0) {
      await clock.delay(Math.min(pollIntervalMs, remaining))
    }
  }

  return undefined
}
