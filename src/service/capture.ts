import type {
  Page,
  ScreencastOptions,
  ScreenRecorder,
  Viewport,
} from 'puppeteer-core'
import type { OutputFormat, ResolvedCaptureOptions } from '../types.js'
import { type ClockBoundary, systemClock } from './boundaries.js'

const FRAME_PRIMING_PAINT_TIMEOUT_MS = 500

export interface StartScreencastOptions {
  capture: ResolvedCaptureOptions
  ffmpegPath: string
  format: OutputFormat
  onViewportRestoreError?: (error: unknown) => void
}

export const startScreencast = async (
  page: Page,
  options: StartScreencastOptions,
): Promise<ScreenRecorder> => {
  const originalViewport = page.viewport()
  if (options.capture.viewport !== 'current') {
    await page.setViewport(options.capture.viewport)
  }

  try {
    return await page.screencast(createScreencastOptions(options))
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
): ScreencastOptions => {
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

export const primeScreencastFrames = async (
  page: Page,
  clock: ClockBoundary = systemClock,
): Promise<void> => {
  const currentViewport = page.viewport()
  const targetViewport = currentViewport ?? (await readCurrentViewport(page))
  if (!targetViewport) {
    return
  }

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
    // emit just the initial frame, which Puppeteer cannot encode alone.
    await waitForViewportPaint(page, clock)
    await clock.delay(50)
  } finally {
    await page.setViewport(currentViewport).catch(() => {
      /* best-effort viewport restore */
    })
  }
}

const waitForViewportPaint = async (
  page: Page,
  clock: ClockBoundary,
): Promise<void> => {
  const { promise: expired, resolve } = Promise.withResolvers<void>()
  const timer = clock.setTimeout(resolve, FRAME_PRIMING_PAINT_TIMEOUT_MS)
  timer.unref()
  try {
    await Promise.race([
      expired,
      // Discard this low-quality snapshot. Do not clip it: Chromium can expose
      // the clip's temporary viewport to the simultaneously running screencast.
      page.screenshot({
        type: 'jpeg',
        quality: 1,
        captureBeyondViewport: false,
      }),
    ])
  } catch {
    /* best-effort priming if the page closes or navigates */
  } finally {
    clock.clearTimeout(timer)
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
