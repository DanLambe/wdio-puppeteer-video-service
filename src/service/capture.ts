import type { CDPSession, Page, Viewport } from 'puppeteer-core'
import type { OutputFormat, ResolvedCaptureOptions } from '../types.js'
import { type ClockBoundary, systemClock } from './boundaries.js'
import {
  recordScreencast,
  type ScreencastRecorder,
  type ScreencastRecorderOptions,
} from './screencast-recorder.js'

const FRAME_PRIMING_PAINT_TIMEOUT_MS = 500
// A screencast started just after its tab's activation changes can drop the
// frames priming produces, and a static page then never emits another. Retry
// priming on this cadence, within this budget, until a second frame arrives.
const FRAME_PRIMING_RECOVERY_INTERVAL_MS = 100
const FRAME_PRIMING_RECOVERY_TIMEOUT_MS = 1_500
const FRAME_PRIMING_HOLD_MS = 50
/**
 * How long a new session waits for its browser to render before any test runs.
 * A browser that has just launched can take seconds to composite anything: on
 * fresh hosted Windows runners its first screencast frame took up to 9.4 s.
 * Recording starts inside a test's timeout and waits about a second for its
 * first frame, so a short first test could end before anything was rendered
 * and record nothing.
 */
export const BROWSER_RENDER_TIMEOUT_MS = 20_000

export type BrowserRenderResult = 'failed' | 'rendered' | 'timed-out'

export interface ScreencastFrameSource {
  /** Timestamped screencast frames delivered since recording started. */
  readonly frameCount: number
}

export type ScreencastRecordFunction = (
  page: Page,
  options: ScreencastRecorderOptions,
) => Promise<ScreencastRecorder>

export interface StartScreencastOptions {
  capture: ResolvedCaptureOptions
  ffmpegPath: string
  format: OutputFormat
  onViewportRestoreError?: (error: unknown) => void
}

export const startScreencast = async (
  page: Page,
  options: StartScreencastOptions,
  record: ScreencastRecordFunction = recordScreencast,
): Promise<ScreencastRecorder> => {
  const originalViewport = page.viewport()
  if (options.capture.viewport !== 'current') {
    await page.setViewport(options.capture.viewport)
  }

  try {
    return await record(page, createScreencastOptions(options))
  } catch (error) {
    if (
      options.capture.crop &&
      error instanceof Error &&
      error.message.startsWith('`crop.')
    ) {
      throw new Error(
        `[WdioPuppeteerVideoService] Invalid capture.crop for capture.viewport at screencast startup. The crop rectangle must fit within the start-time viewport: ${error.message}`,
        { cause: error },
      )
    }
    throw error
  } finally {
    if (options.capture.viewport !== 'current') {
      await page.setViewport(originalViewport).catch((error) => {
        options.onViewportRestoreError?.(error)
      })
    }
  }
}

export const createScreencastOptions = (
  options: Pick<StartScreencastOptions, 'capture' | 'ffmpegPath' | 'format'>,
): ScreencastRecorderOptions => {
  const { capture } = options
  return {
    format: options.format,
    fps: capture.fps,
    quality: capture.quality,
    scale: capture.scale,
    speed: capture.speed,
    ffmpegPath: options.ffmpegPath,
    ...(capture.crop ? { crop: capture.crop } : {}),
  }
}

/**
 * Prime the screencast so the recording starts from the page's current state.
 * Resolves `false` only when an observed screencast still had fewer than two
 * frames once recovery ran out of time, which means the screencast stalled
 * after its first frame. Recovery scheduling is bounded; an in-flight
 * viewport/paint operation and its restoration are always awaited.
 */
export const primeScreencastFrames = async (
  page: Page,
  clock: ClockBoundary = systemClock,
  frames?: ScreencastFrameSource,
): Promise<boolean> => {
  const currentViewport = page.viewport()
  const targetViewport = currentViewport ?? (await readCurrentViewport(page))
  if (!targetViewport) {
    return true
  }

  await warmViewport(page, clock, currentViewport, targetViewport)
  if (!frames) {
    return true
  }
  // A tab whose activation just changed can swallow every frame priming
  // produced. Give an in-flight frame time to land, then prime again once the
  // tab has settled.
  const deadline = clock.now() + FRAME_PRIMING_RECOVERY_TIMEOUT_MS
  while (frames.frameCount < 2 && clock.now() < deadline) {
    await clock.delay(
      Math.min(FRAME_PRIMING_RECOVERY_INTERVAL_MS, deadline - clock.now()),
    )
    if (frames.frameCount >= 2 || clock.now() >= deadline) {
      break
    }
    await warmViewport(page, clock, currentViewport, targetViewport)
  }
  return frames.frameCount >= 2
}
const warmViewport = async (
  page: Page,
  clock: ClockBoundary,
  currentViewport: Viewport | null,
  targetViewport: Pick<Viewport, 'width' | 'height'>,
): Promise<void> => {
  try {
    await page
      .setViewport({
        ...targetViewport,
        width: targetViewport.width + 1,
      })
      .catch(() => {
        /* best-effort viewport resize */
      })
    // A timer or animation callback alone does not ensure a compositor frame.
    // Request a paint before restoring the viewport; a static tab may otherwise
    // emit just its initial frame.
    await waitForPagePaint(page, clock, FRAME_PRIMING_PAINT_TIMEOUT_MS)
    await clock.delay(FRAME_PRIMING_HOLD_MS)
  } finally {
    await page.setViewport(currentViewport).catch(() => {
      /* best-effort viewport restore */
    })
  }
}

/**
 * Resolves once the browser has composited `page`: a paint request completes
 * only after a rendered frame. A request that fails is not a rendering delay,
 * so it resolves `failed` at once.
 */
export const waitForBrowserToRender = async (
  page: Page,
  clock: ClockBoundary = systemClock,
): Promise<BrowserRenderResult> => {
  return waitForPagePaint(page, clock, BROWSER_RENDER_TIMEOUT_MS)
}

const waitForPagePaint = async (
  page: Page,
  clock: ClockBoundary,
  timeoutMs: number,
): Promise<BrowserRenderResult> => {
  let completed = false
  let session: CDPSession | undefined
  const detach = (): void => {
    const owned = session
    session = undefined
    // Do not let an unresponsive target's detach extend the render budget.
    void owned?.detach().catch(() => undefined)
  }
  const paint = async (): Promise<BrowserRenderResult> => {
    try {
      session = await page.createCDPSession()
      if (completed) {
        return 'timed-out'
      }
      // page.screenshot holds Puppeteer's browser/context screenshot locks.
      // Racing it with a timer leaves newPage/close/screenshots blocked after
      // timeout. Use a disposable session, never the shared page session.
      // No clip: it can expose a temporary viewport to an active screencast.
      await session.send(
        'Page.captureScreenshot',
        {
          format: 'jpeg',
          quality: 1,
          fromSurface: true,
          captureBeyondViewport: false,
        },
        { timeout: timeoutMs },
      )
      return 'rendered'
    } catch {
      return 'failed'
    } finally {
      // Also releases a session whose creation completed after our deadline.
      detach()
    }
  }
  const { promise: expired, resolve } =
    Promise.withResolvers<BrowserRenderResult>()
  const timer = clock.setTimeout(() => {
    completed = true
    resolve('timed-out')
  }, timeoutMs)
  timer.unref?.()
  try {
    return await Promise.race([expired, paint()])
  } finally {
    completed = true
    clock.clearTimeout(timer)
    detach()
  }
}

const readCurrentViewport = async (
  page: Page,
): Promise<Pick<Viewport, 'width' | 'height'> | undefined> => {
  try {
    const viewport = await page.evaluate(() => ({
      height: (globalThis as typeof globalThis & { innerHeight: number })
        .innerHeight,
      width: (globalThis as typeof globalThis & { innerWidth: number })
        .innerWidth,
    }))
    if (viewport.width <= 0 || viewport.height <= 0) {
      return undefined
    }
    return viewport
  } catch {
    return undefined
  }
}
