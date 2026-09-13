import type {
  Page,
  ScreencastOptions,
  ScreenRecorder,
  Viewport,
} from 'puppeteer-core'
import type { OutputFormat, ResolvedCaptureOptions } from '../types.js'
import { type ClockBoundary, systemClock } from './boundaries.js'

const FRAME_PRIMING_PAINT_TIMEOUT_MS = 500
// A screencast started just after its tab's activation changes can drop the
// frames priming produces, and a static page then never emits another. Retry
// priming on this cadence, within this budget, until a second frame arrives.
const FRAME_PRIMING_RECOVERY_INTERVAL_MS = 100
const FRAME_PRIMING_RECOVERY_TIMEOUT_MS = 1_500

export interface ScreencastFrameObserver {
  readonly frameCount: number
  dispose(): void
}

interface ScreencastEventSource {
  on(event: string, listener: (event: unknown) => void): unknown
  off(event: string, listener: (event: unknown) => void): unknown
}

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

/**
 * Count the screencast frames Puppeteer's recorder will encode. This listens on
 * the main frame's CDP session, the channel `ScreenRecorder` itself uses. That
 * session is not public API, so when it is unreachable frame verification is
 * skipped rather than failing capture.
 */
export const observeScreencastFrames = (
  page: Page,
): ScreencastFrameObserver | undefined => {
  let source: unknown
  try {
    source = Reflect.get(page.mainFrame(), 'client')
  } catch {
    return undefined
  }
  if (!isScreencastEventSource(source)) {
    return undefined
  }
  const events = source
  let frameCount = 0
  const onFrame = (event: unknown): void => {
    if (hasFrameTimestamp(event)) {
      frameCount += 1
    }
  }
  events.on('Page.screencastFrame', onFrame)
  return {
    get frameCount(): number {
      return frameCount
    },
    dispose: () => {
      events.off('Page.screencastFrame', onFrame)
    },
  }
}

/**
 * Prime the screencast so Puppeteer has frames to encode. Resolves `false` only
 * when an observed screencast still had fewer than two frames once recovery
 * ran out of time; Puppeteer encodes a frame only when the next one arrives, so
 * that recording is likely empty.
 */
export const primeScreencastFrames = async (
  page: Page,
  clock: ClockBoundary = systemClock,
  frames?: ScreencastFrameObserver,
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
    await clock.delay(FRAME_PRIMING_RECOVERY_INTERVAL_MS)
    if (frames.frameCount >= 2) {
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
  timer.unref?.()
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

const isScreencastEventSource = (
  value: unknown,
): value is ScreencastEventSource => {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'on') === 'function' &&
    typeof Reflect.get(value, 'off') === 'function'
  )
}

// Mirror ScreenRecorder, which drops frames without a timestamp before encoding.
const hasFrameTimestamp = (event: unknown): boolean => {
  if (typeof event !== 'object' || event === null) {
    return false
  }
  const metadata: unknown = Reflect.get(event, 'metadata')
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    Reflect.get(metadata, 'timestamp') !== undefined
  )
}
