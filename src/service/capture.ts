import type {
  Page,
  ScreencastOptions,
  ScreenRecorder,
  Viewport,
} from 'puppeteer-core'
import type { OutputFormat, ResolvedCaptureOptions } from '../types.js'
import { type ClockBoundary, systemClock } from './boundaries.js'

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

  await page
    .setViewport({
      ...targetViewport,
      width: targetViewport.width + 1,
    })
    .catch(() => {
      /* best-effort viewport resize */
    })
  await clock.delay(50)
  await page.setViewport(currentViewport).catch(() => {
    /* best-effort viewport restore */
  })
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
