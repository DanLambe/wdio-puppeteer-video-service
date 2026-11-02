import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { Page } from 'puppeteer-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ClockBoundary,
  nodeFileSystem,
} from '../../src/service/boundaries.js'
import { CaptureSession } from '../../src/service/capture-session.js'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import { PAGE_MARKER_PROPERTY } from '../../src/service/page-lookup.js'
import {
  type CaptureTarget,
  PuppeteerCaptureEngine,
} from '../../src/service/puppeteer-capture-engine.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { force: true, recursive: true })),
  )
})

const createClock = (): ClockBoundary => {
  let now = 0
  return {
    clearInterval: () => {},
    clearTimeout: () => {},
    delay: async (milliseconds) => {
      now += milliseconds
    },
    now: () => now,
    queueMicrotask,
    setInterval: () => ({}) as NodeJS.Timeout,
    setTimeout: () => ({}) as NodeJS.Timeout,
  }
}

const createRecorder = () => {
  const recorder = new PassThrough() as PassThrough & Record<string, unknown>
  Object.assign(recorder, {
    abort: vi.fn(async () => recorder.destroy()),
    ffmpegResult: { code: 0, diagnostic: '', signal: null },
    frameCount: 1,
    incompleteReason: undefined,
    queueStats: {
      highWaterBlocks: 0,
      highWaterBytes: 0,
      highWaterLagSeconds: 0,
      pendingBlocks: 0,
      pendingBytes: 0,
    },
    stop: vi.fn(async () => recorder.end()),
  })
  return recorder
}

/** A page whose CDP target id is `targetId` and whose marker the test controls. */
const createPage = (targetId: string) => {
  const state = { closed: false, marker: undefined as unknown }
  const page = {
    bringToFront: vi.fn(async () => {}),
    createCDPSession: vi.fn(async () => ({
      detach: async () => {},
      send: async () => ({ targetInfo: { targetId } }),
    })),
    evaluate: vi.fn(async () => state.marker),
    isClosed: () => state.closed,
    setViewport: vi.fn(async () => {}),
    viewport: () => ({ height: 600, width: 800 }),
  }
  return { page: page as unknown as Page, raw: page, state }
}

const createHarness = (
  pages: ReturnType<typeof createPage>[],
  clock: ClockBoundary = createClock(),
) => {
  const session = new CaptureSession()
  const logs: string[] = []
  const markerCalls: unknown[] = []
  const browser = {
    capabilities: { browserName: 'chrome' },
    execute: vi.fn(
      async (
        _callback: unknown,
        _property: string,
        id: string,
      ): Promise<void> => {
        // Classic marker: lands in WDIO's current window, the first page.
        if (pages[0]) {
          pages[0].state.marker = id
        }
      },
    ),
    getWindowHandle: vi.fn(async () => 'tab-a'),
    isBidi: true,
    options: { hostname: 'localhost' },
    scriptCallFunction: vi.fn(
      async (parameters: {
        arguments: Array<{ type: string; value?: string }>
        target: { context: string }
      }) => {
        markerCalls.push(parameters)
        const value = parameters.arguments[2]
        // Context `marked-N` is the Nth page.
        const page = pages.find(
          (_candidate, index) =>
            parameters.target.context === `marked-${index.toString()}`,
        )
        if (page) {
          page.state.marker = value?.type === 'null' ? undefined : value?.value
        }
      },
    ),
  }
  session.setBrowser(browser as never)
  const startScreencast = vi.fn(async () => createRecorder() as never)
  const engine = new PuppeteerCaptureEngine({
    capture: resolveServiceConfiguration({ capture: { framePriming: false } })
      .options.capture,
    clock,
    connectPuppeteer: vi.fn(
      async () =>
        ({
          connected: true,
          pages: async () => pages.map(({ page }) => page),
        }) as never,
    ),
    fileSystem: nodeFileSystem,
    getSessionToken: () => 'token',
    log: (_level, message) => {
      logs.push(message)
    },
    onConnectionFailure: () => {},
    onProtocolChanged: () => {},
    session,
    startScreencast,
    uuid: () => 'uuid',
  })
  const start = async (target?: CaptureTarget) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-bidi-'))
    tempDirs.push(dir)
    const outputPath = path.join(dir, 'capture.webm')
    if (!session.currentTestSlug) {
      session.beginRecording('tabs')
    }
    return engine.startCapture({
      createOutput: async () => {
        await fs.writeFile(outputPath, '')
        return {
          outputFormat: 'webm',
          outputPath,
          recordingFormat: 'webm',
          recordingPath: outputPath,
          transcodeEnabled: false,
        }
      },
      ffmpegPath: 'ffmpeg',
      ...(target ? { target } : {}),
      transcodeOptions: { deleteOriginal: true },
    })
  }
  return { browser, engine, logs, markerCalls, session, start, startScreencast }
}

describe('PuppeteerCaptureEngine in WebDriver BiDi sessions', () => {
  it('records the page whose target id is WDIO’s current window', async () => {
    const tabA = createPage('tab-a')
    const tabB = createPage('tab-b')
    const harness = createHarness([tabB, tabA])

    await expect(harness.start()).resolves.toEqual({ started: true })

    expect(harness.startScreencast).toHaveBeenCalledWith(
      tabA.page,
      expect.anything(),
    )
    expect(harness.browser.execute).not.toHaveBeenCalled()
    expect(tabA.raw.bringToFront).toHaveBeenCalledOnce()
    expect([...harness.session.segmentTabs.values()]).toEqual([
      { contextId: 'tab-a', ordinal: 1, reason: 'start' },
    ])
  })

  it('records an explicitly requested tab and why it started there', async () => {
    const tabA = createPage('tab-a')
    const tabB = createPage('tab-b')
    const harness = createHarness([tabA, tabB])

    await harness.start({ contextId: 'tab-b', reason: 'command' })

    expect(harness.startScreencast).toHaveBeenCalledWith(
      tabB.page,
      expect.anything(),
    )
    expect(harness.session.currentWindowHandle).toBe('tab-b')
    expect(harness.browser.getWindowHandle).not.toHaveBeenCalled()
    expect([...harness.session.segmentTabs.values()]).toEqual([
      { contextId: 'tab-b', ordinal: 1, reason: 'command' },
    ])
  })

  it('marks a requested context it cannot match by target id', async () => {
    // The page reports another target id, so only its marker identifies it.
    const unmatched = createPage('other-target')
    const harness = createHarness([unmatched])

    await expect(
      harness.start({ contextId: 'marked-0', reason: 'command' }),
    ).resolves.toEqual({ started: true })

    expect(harness.startScreencast).toHaveBeenCalledWith(
      unmatched.page,
      expect.anything(),
    )
    expect(harness.logs).toContainEqual(
      expect.stringContaining(
        'No page has the target id of browsing context marked-0',
      ),
    )
    // The marker went into the requested context, never WDIO's current one,
    // and was removed afterwards.
    expect(harness.browser.execute).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(harness.markerCalls).toHaveLength(2))
    expect(unmatched.state.marker).toBeUndefined()
    expect(PAGE_MARKER_PROPERTY).toContain('Marker')
  })

  it('gives up on a marker within its budget and removes it if it lands later', async () => {
    // Timers fire once pending work has run, moving the clock to their due time.
    let now = 0
    const clock: ClockBoundary = {
      ...createClock(),
      clearTimeout: (timer) => {
        clearImmediate(timer as unknown as NodeJS.Immediate)
      },
      delay: async (milliseconds) => {
        now += milliseconds
      },
      now: () => now,
      setTimeout: (callback: () => void, milliseconds: number) => {
        const due = now + milliseconds
        return setImmediate(() => {
          now = Math.max(now, due)
          callback()
        }) as unknown as NodeJS.Timeout
      },
    }
    const late = createPage('other-target')
    const harness = createHarness([late], clock)
    const landed = Promise.withResolvers<void>()
    const setMarker = harness.browser.scriptCallFunction.getMockImplementation()
    harness.browser.scriptCallFunction.mockImplementationOnce(
      async (parameters) => {
        await landed.promise
        await setMarker?.(parameters)
      },
    )

    await expect(
      harness.start({ contextId: 'marked-0', reason: 'command' }),
    ).resolves.toEqual({ started: false })
    // The target-id lookup, then the marker fallback: one budget each.
    expect(now).toBe(4_000)
    expect(harness.logs).toContainEqual(
      expect.stringContaining(
        'Marking the browsing context to record timed out',
      ),
    )

    landed.resolve()
    await vi.waitFor(() => expect(harness.markerCalls).toHaveLength(2))
    expect(late.state.marker).toBeUndefined()
  })

  it('skips a requested context it cannot reach', async () => {
    const harness = createHarness([createPage('tab-a')])
    harness.browser.scriptCallFunction.mockRejectedValueOnce(new Error('gone'))

    await expect(
      harness.start({ contextId: 'tab-z', reason: 'command' }),
    ).resolves.toEqual({ started: false })

    expect(harness.logs).toContainEqual(
      expect.stringContaining('Could not mark the browsing context'),
    )
    expect(harness.logs).toContainEqual(
      expect.stringContaining('Could not find puppeteer page match'),
    )
  })

  it('falls back to WDIO’s current-window marker without a requested context', async () => {
    const unmatched = createPage('other-target')
    const harness = createHarness([unmatched])

    await expect(harness.start()).resolves.toEqual({ started: true })

    expect(harness.browser.execute).toHaveBeenCalled()
    expect(harness.startScreencast).toHaveBeenCalledWith(
      unmatched.page,
      expect.anything(),
    )
  })

  it('reports a recorded page that closed and WDIO’s current window', async () => {
    const tabA = createPage('tab-a')
    const harness = createHarness([tabA])

    expect(harness.engine.isRecordedPageClosed).toBe(false)
    await harness.start()
    expect(harness.engine.isRecordedPageClosed).toBe(false)
    tabA.state.closed = true
    expect(harness.engine.isRecordedPageClosed).toBe(true)

    await harness.engine.stopCapture({ discard: true })
    expect(harness.engine.isRecordedPageClosed).toBe(false)

    await expect(harness.engine.currentWindowHandle()).resolves.toBe('tab-a')
    harness.browser.getWindowHandle.mockRejectedValueOnce(new Error('closed'))
    await expect(harness.engine.currentWindowHandle()).resolves.toBeUndefined()
  })
})
