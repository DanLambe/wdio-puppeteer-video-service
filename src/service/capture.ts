import type {
  Page,
  ScreencastOptions,
  ScreenRecorder,
  Viewport,
} from 'puppeteer-core'
import type {
  OutputFormat,
  ResolvedWdioPuppeteerVideoServiceOptions,
} from '../types.js'
import { type ClockBoundary, systemClock } from './boundaries.js'

type ResolvedCaptureOptions = Pick<
  ResolvedWdioPuppeteerVideoServiceOptions,
  | 'captureCrop'
  | 'captureQuality'
  | 'captureScale'
  | 'captureSpeed'
  | 'captureViewport'
  | 'fps'
>

export interface StartScreencastOptions {
  capture: ResolvedCaptureOptions
  ffmpegPath: string
  format: OutputFormat
  onViewportRestoreError?: (error: unknown) => void
}

export interface CaptureDimensions {
  width: number
  height: number
}

export const startScreencast = async (
  page: Page,
  options: StartScreencastOptions,
): Promise<ScreenRecorder> => {
  const originalViewport = page.viewport()
  if (options.capture.captureViewport !== 'current') {
    await page.setViewport(options.capture.captureViewport)
  }

  try {
    return await page.screencast(createScreencastOptions(options))
  } finally {
    if (options.capture.captureViewport !== 'current') {
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
    quality: capture.captureQuality,
    scale: capture.captureScale,
    speed: capture.captureSpeed,
    ffmpegPath: options.ffmpegPath,
    ...(capture.captureCrop ? { crop: capture.captureCrop } : {}),
  }
}

export const resolveCaptureDimensions = async (
  page: Page,
  capture: ResolvedCaptureOptions,
): Promise<CaptureDimensions | undefined> => {
  const currentViewport =
    typeof page.viewport === 'function' ? page.viewport() : null
  const viewport =
    capture.captureViewport === 'current'
      ? (currentViewport ?? (await readCurrentViewport(page)))
      : capture.captureViewport
  const source = capture.captureCrop ?? viewport
  if (!source) {
    return undefined
  }
  return {
    width: Math.max(1, Math.round(source.width * capture.captureScale)),
    height: Math.max(1, Math.round(source.height * capture.captureScale)),
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
