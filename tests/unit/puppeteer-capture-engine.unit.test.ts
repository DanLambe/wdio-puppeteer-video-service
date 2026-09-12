import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { Page, ScreenRecorder } from 'puppeteer-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ClockBoundary,
  type FileSystemBoundary,
  nodeFileSystem,
  systemClock,
} from '../../src/service/boundaries.js'
import type { StartScreencastOptions } from '../../src/service/capture.js'
import { CaptureSession } from '../../src/service/capture-session.js'
import type { ActiveSegment } from '../../src/service/constants.js'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import { PAGE_MARKER_PROPERTY } from '../../src/service/page-lookup.js'
import {
  type CaptureWindowOperations,
  PuppeteerCaptureEngine,
} from '../../src/service/puppeteer-capture-engine.js'

type FakeRecorder = PassThrough & {
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>
}

const tempDirs: string[] = []

const createTempDir = async (): Promise<string> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-engine-'))
  tempDirs.push(tempDir)
  return tempDir
}

const createRecorder = (): FakeRecorder => {
  const recorder = new PassThrough() as FakeRecorder
  recorder.stop = vi.fn(async () => {
    recorder.end()
  })
  return recorder
}

const createHarness = (
  options: {
    clock?: ClockBoundary
    connectError?: Error
    fileSystem?: FileSystemBoundary
    framePriming?: boolean
    recorder?: FakeRecorder
    sessionToken?: string
  } = {},
) => {
  const session = new CaptureSession()
  const recorder = options.recorder ?? createRecorder()
  const descriptors: Array<PropertyDescriptor | undefined> = []
  const markerIds: string[] = []
  const page = {
    bringToFront: vi.fn(async () => {}),
    evaluate: vi.fn(
      async (callback: (property: string) => unknown, property: string) => {
        descriptors.push(Object.getOwnPropertyDescriptor(globalThis, property))
        return callback(property)
      },
    ),
    setViewport: vi.fn(async () => {}),
    viewport: vi.fn(() => ({ height: 600, width: 800 })),
  } as unknown as Page
  const puppeteerBrowser = {
    connected: true,
    pages: vi.fn(async () => [page]),
  }
  const connectPuppeteer = vi.fn(async () => {
    if (options.connectError) {
      throw options.connectError
    }
    return puppeteerBrowser as never
  })
  const browser = {
    capabilities: {
      browserName: 'chrome',
      webSocketUrl: 'ws://localhost/bidi',
    },
    execute: vi.fn(
      async (
        callback: (property: string, id: string) => void,
        property: string,
        id: string,
      ) => {
        markerIds.push(id)
        callback(property, id)
      },
    ),
    getWindowHandle: vi.fn(async () => 'window-1'),
    getWindowHandles: vi.fn(async () => ['window-1']),
    options: { hostname: 'localhost' },
  }
  session.setBrowser(browser as never)
  const failures: string[] = []
  const logs: Array<{ level: string; message: string }> = []
  const protocols: string[] = []
  let uuidIndex = 0
  const capture = resolveServiceConfiguration({
    capture: { framePriming: options.framePriming ?? false },
  }).options.capture
  const startScreencast = vi.fn(
    async (_page: Page, _options: StartScreencastOptions) => recorder as never,
  )
  const engine = new PuppeteerCaptureEngine({
    capture,
    clock: options.clock ?? systemClock,
    connectPuppeteer,
    fileSystem: options.fileSystem ?? nodeFileSystem,
    getSessionToken: () => options.sessionToken ?? 'session-token',
    log: (level, message) => {
      logs.push({ level, message })
    },
    onConnectionFailure: (reason) => {
      failures.push(reason)
    },
    onProtocolChanged: (protocol) => {
      protocols.push(protocol)
    },
    session,
    startScreencast,
    uuid: () => {
      uuidIndex += 1
      return `uuid-${uuidIndex.toString()}`
    },
  })

  return {
    browser,
    connectPuppeteer,
    descriptors,
    engine,
    failures,
    logs,
    markerIds,
    page,
    protocols,
    puppeteerBrowser,
    recorder,
    session,
    startScreencast,
  }
}

const startCapture = async (
  harness: ReturnType<typeof createHarness>,
  outputPath: string,
) => {
  harness.session.beginRecording('checkout')
  return harness.engine.startCapture({
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
    ffmpegPath: 'ffmpeg.exe',
    transcodeOptions: { deleteOriginal: true },
  })
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  Reflect.deleteProperty(globalThis, PAGE_MARKER_PROPERTY)
  await Promise.all(
    tempDirs
      .splice(0)
      .map((tempDir) => fs.rm(tempDir, { force: true, recursive: true })),
  )
})

describe('Puppeteer capture engine', () => {
  it('connects once and uses unique non-enumerable page markers', async () => {
    const harness = createHarness()

    await expect(harness.engine.preparePage()).resolves.toMatchObject({
      page: harness.page,
      windowHandle: 'window-1',
    })
    await expect(harness.engine.preparePage()).resolves.toBeDefined()

    expect(harness.connectPuppeteer).toHaveBeenCalledOnce()
    expect(harness.descriptors).toHaveLength(2)
    expect(
      harness.descriptors.every(
        (descriptor) => descriptor?.enumerable === false,
      ),
    ).toBe(true)
    expect(harness.markerIds[0]).not.toBe(harness.markerIds[2])
    expect(Reflect.has(globalThis, PAGE_MARKER_PROPERTY)).toBe(false)
    expect(harness.session.protocol).toBe('bidi+cdp')
    expect(harness.protocols).toEqual(['bidi+cdp'])
  })

  it('classifies connection failures and leaves the session unsupported', async () => {
    const harness = createHarness({
      connectError: new Error('CDP unavailable'),
    })

    await expect(harness.engine.preparePage()).resolves.toBeUndefined()

    expect(harness.failures[0]).toContain('CDP endpoint')
    expect(harness.session.puppeteerBrowser).toBeUndefined()
    expect(harness.session.protocol).toBe('unsupported')
    expect(harness.protocols).toEqual(['unsupported'])
  })

  it('skips page lookup when no WDIO browser is attached', async () => {
    const harness = createHarness()
    harness.session.clearBrowser()

    await expect(harness.engine.preparePage()).resolves.toBeUndefined()

    expect(harness.connectPuppeteer).not.toHaveBeenCalled()
  })

  it('reconnects a disconnected Puppeteer browser and classifies classic WebDriver', async () => {
    const harness = createHarness()
    Reflect.deleteProperty(harness.browser.capabilities, 'webSocketUrl')
    harness.session.setConnection(
      { ...harness.puppeteerBrowser, connected: false } as never,
      'bidi+cdp',
    )

    await expect(harness.engine.preparePage()).resolves.toBeDefined()

    expect(harness.connectPuppeteer).toHaveBeenCalledOnce()
    expect(harness.session.protocol).toBe('classic+cdp')
    expect(harness.logs.at(-1)?.message).toContain('classic WebDriver')
  })

  it('bounds missing-page lookup and skips output creation', async () => {
    let now = 0
    const clock: ClockBoundary = {
      ...systemClock,
      delay: vi.fn(async (milliseconds: number) => {
        now += milliseconds
      }),
      now: () => now,
    }
    const harness = createHarness({ clock })
    harness.puppeteerBrowser.pages.mockResolvedValue([])
    harness.session.beginRecording('missing-page')
    const createOutput = vi.fn(async () => {
      throw new Error('output must not be created')
    })

    await expect(
      harness.engine.startCapture({
        createOutput,
        ffmpegPath: 'ffmpeg.exe',
        transcodeOptions: { deleteOriginal: true },
      }),
    ).resolves.toEqual({ started: false })

    expect(createOutput).not.toHaveBeenCalled()
    expect(harness.logs.at(-1)?.message).toContain(
      'Could not find puppeteer page match',
    )
  })

  it('uses a pending marker token and contains marker cleanup failures', async () => {
    const harness = createHarness({ sessionToken: '' })
    const execute = harness.browser.execute.getMockImplementation()
    if (!execute) {
      throw new Error('Expected execute implementation')
    }
    harness.browser.execute
      .mockImplementationOnce(execute)
      .mockRejectedValueOnce(new Error('target closed during cleanup'))

    await expect(harness.engine.preparePage()).resolves.toBeDefined()

    expect(harness.markerIds[0]).toContain('wdio-video-pending-')
  })

  it('streams a segment to disk and returns a clean stopped capture', async () => {
    const tempDir = await createTempDir()
    const outputPath = path.join(tempDir, 'capture.webm')
    const harness = createHarness()

    await expect(startCapture(harness, outputPath)).resolves.toEqual({
      started: true,
    })
    harness.recorder.write('recorded-bytes')
    const stopped = await harness.engine.stopCapture()

    expect(stopped.streamOk).toBe(true)
    expect(stopped.segment?.recordingPath).toBe(outputPath)
    expect(harness.session.hasCapture).toBe(false)
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe(
      'recorded-bytes',
    )
  })

  it('clears and unreferences stream timeouts after clean completion', async () => {
    const tempDir = await createTempDir()
    const outputPath = path.join(tempDir, 'capture.webm')
    const timers: Array<{ unref: ReturnType<typeof vi.fn> }> = []
    const clearTimeout = vi.fn()
    const clock: ClockBoundary = {
      ...systemClock,
      clearTimeout,
      setTimeout: vi.fn(() => {
        const timer = { unref: vi.fn() }
        timers.push(timer)
        return timer as unknown as NodeJS.Timeout
      }),
    }
    const harness = createHarness({ clock })

    await startCapture(harness, outputPath)
    harness.recorder.write('recorded-bytes')
    await expect(harness.engine.stopCapture()).resolves.toMatchObject({
      streamOk: true,
    })

    expect(timers).toHaveLength(2)
    expect(timers.every((timer) => timer.unref.mock.calls.length === 1)).toBe(
      true,
    )
    expect(clearTimeout.mock.calls.map(([timer]) => timer)).toEqual(timers)
  })

  it('handles unavailable priming viewport and reports viewport restore failures', async () => {
    const tempDir = await createTempDir()
    const outputPath = path.join(tempDir, 'capture.webm')
    const harness = createHarness({ framePriming: true })
    vi.mocked(harness.page.viewport).mockReturnValue(null)
    const evaluate = vi.mocked(harness.page.evaluate)
    const evaluateMarker = evaluate.getMockImplementation()
    if (!evaluateMarker) {
      throw new Error('Expected page evaluate implementation')
    }
    evaluate
      .mockImplementationOnce(evaluateMarker)
      .mockResolvedValueOnce({ height: 0, width: 0 })
    harness.startScreencast.mockImplementationOnce(async (_page, options) => {
      options.onViewportRestoreError?.(new Error('viewport closed'))
      return harness.recorder as never
    })

    await expect(startCapture(harness, outputPath)).resolves.toEqual({
      started: true,
    })
    harness.recorder.end()
    await harness.engine.stopCapture()

    expect(
      harness.logs.some(({ message }) => message.includes('viewport closed')),
    ).toBe(true)
  })

  it('cleans reserved output when screencast startup fails', async () => {
    const tempDir = await createTempDir()
    const outputPath = path.join(tempDir, 'capture.webm')
    const harness = createHarness()
    harness.startScreencast.mockRejectedValueOnce(
      new Error('screencast unavailable'),
    )

    await expect(startCapture(harness, outputPath)).rejects.toThrow(
      'screencast unavailable',
    )

    expect(harness.recorder.stop).not.toHaveBeenCalled()
    await expect(fs.stat(outputPath)).rejects.toThrow()
  })

  it('propagates output creation failures without starting a recorder', async () => {
    const harness = createHarness()
    harness.session.beginRecording('output-failure')

    await expect(
      harness.engine.startCapture({
        createOutput: async () => {
          throw new Error('reservation failed')
        },
        ffmpegPath: 'ffmpeg.exe',
        transcodeOptions: { deleteOriginal: true },
      }),
    ).rejects.toThrow('reservation failed')

    expect(harness.startScreencast).not.toHaveBeenCalled()
  })

  it('cleans recorder and reservation state when piping fails', async () => {
    const tempDir = await createTempDir()
    const outputPath = path.join(tempDir, 'capture.webm')
    const harness = createHarness()
    vi.spyOn(harness.recorder, 'pipe').mockImplementation(() => {
      const error = new Error('pipe closed') as NodeJS.ErrnoException
      error.code = 'EPIPE'
      throw error
    })

    await expect(startCapture(harness, outputPath)).rejects.toThrow(
      'pipe closed',
    )

    expect(harness.recorder.stop).toHaveBeenCalledOnce()
    expect(harness.recorder.destroyed).toBe(true)
    expect(harness.session.hasCapture).toBe(false)
    await expect(fs.stat(outputPath)).rejects.toThrow()
  })

  it('marks a segment unclean when its stream reports EPIPE', async () => {
    const tempDir = await createTempDir()
    const outputPath = path.join(tempDir, 'capture.webm')
    const harness = createHarness()
    await startCapture(harness, outputPath)
    harness.recorder.write('recoverable-media')
    const error = new Error('broken pipe') as NodeJS.ErrnoException
    error.code = 'EPIPE'
    harness.session.activeSegment?.onWriteStreamError(error)

    const stopped = await harness.engine.stopCapture()

    expect(stopped.streamOk).toBe(false)
    expect(stopped.segment).toMatchObject({
      outputFormat: 'webm',
      outputPath,
      recordingPath: outputPath,
      transcode: false,
    })
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe(
      'recoverable-media',
    )
  })

  it('reports non-benign stream and recorder errors once per segment', async () => {
    const tempDir = await createTempDir()
    const outputPath = path.join(tempDir, 'capture.webm')
    const harness = createHarness()
    await startCapture(harness, outputPath)
    harness.recorder.write('recoverable-media')
    const writeError = new Error('disk unavailable') as NodeJS.ErrnoException
    writeError.code = 'EIO'
    harness.session.activeSegment?.onWriteStreamError(writeError)
    harness.session.activeSegment?.onWriteStreamError(writeError)
    harness.session.activeSegment?.onRecorderError(new Error('target lost'))
    harness.session.activeSegment?.onRecorderError(new Error('duplicate'))

    await harness.engine.stopCapture()

    expect(
      harness.logs.filter(({ message }) =>
        message.includes('Recording stream error: disk unavailable'),
      ),
    ).toHaveLength(1)
    expect(
      harness.logs.filter(({ message }) =>
        message.includes('Recorder stream error: target lost'),
      ),
    ).toHaveLength(1)
  })

  it('returns an empty result when no capture is attached', async () => {
    const harness = createHarness()

    await expect(harness.engine.stopCapture()).resolves.toEqual({
      segment: undefined,
      streamOk: false,
    })
  })

  it('contains a rejected stream completion after an earlier write error', async () => {
    const harness = createHarness()
    const writeStreamDone = Promise.reject(new Error('stream failed'))
    const recorder = {
      destroyed: false,
      destroy: vi.fn(),
      off: vi.fn(),
      stop: vi.fn(async () => {}),
    } as unknown as ScreenRecorder
    const segment = {
      onRecorderError: vi.fn(),
      onWriteStreamError: vi.fn(),
      outputFormat: 'webm',
      outputPath: 'capture.webm',
      recordingFormat: 'webm',
      recordingPath: 'capture.webm',
      transcode: false,
      transcodeOptions: { deleteOriginal: true },
      writeStream: { off: vi.fn() },
      writeStreamDone,
      writeStreamErrored: true,
    } as unknown as ActiveSegment
    harness.session.beginRecording('write-error')
    harness.session.attachCapture({
      recorder,
      segment,
      windowHandle: undefined,
    })

    await expect(harness.engine.stopCapture()).resolves.toMatchObject({
      streamOk: false,
    })
  })

  it('destroys a recorder when stop does not settle', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const stop = vi.fn(() => new Promise<void>(() => {}))
    const destroy = vi.fn()
    const recorder = {
      destroyed: false,
      destroy() {
        recorder.destroyed = true
        destroy()
      },
      off: vi.fn(),
      stop,
    } as unknown as ScreenRecorder
    const segment = {
      onRecorderError: vi.fn(),
      onWriteStreamError: vi.fn(),
      outputFormat: 'webm',
      outputPath: 'capture.webm',
      recordingFormat: 'webm',
      recordingPath: 'capture.webm',
      transcode: false,
      transcodeOptions: { deleteOriginal: true },
      writeStream: { off: vi.fn() },
      writeStreamDone: Promise.resolve(),
      writeStreamErrored: false,
    } as unknown as ActiveSegment
    harness.session.beginRecording('timeout')
    harness.session.attachCapture({
      recorder,
      segment,
      windowHandle: undefined,
    })

    const stopTask = harness.engine.stopCapture()
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(stopTask).resolves.toMatchObject({ streamOk: true })
    expect(stop).toHaveBeenCalledOnce()
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('destroys a write stream that exceeds the bounded completion timeout', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    let rejectCompletion: ((error: Error) => void) | undefined
    const writeStreamDone = new Promise<void>((_resolve, reject) => {
      rejectCompletion = reject
    })
    const writeStream = {
      destroyed: false,
      destroy(error: Error) {
        writeStream.destroyed = true
        rejectCompletion?.(error)
      },
      off: vi.fn(),
    }
    const recorder = {
      destroyed: false,
      destroy: vi.fn(),
      off: vi.fn(),
      stop: vi.fn(async () => {}),
    } as unknown as ScreenRecorder
    const segment = {
      onRecorderError: vi.fn(),
      onWriteStreamError: vi.fn(),
      outputFormat: 'mp4',
      outputPath: 'capture.mp4',
      recordingFormat: 'webm',
      recordingPath: 'capture.webm',
      transcode: true,
      transcodeOptions: { deleteOriginal: true },
      writeStream,
      writeStreamDone,
      writeStreamErrored: false,
    } as unknown as ActiveSegment
    harness.session.beginRecording('timeout')
    harness.session.attachCapture({
      recorder,
      segment,
      windowHandle: undefined,
    })

    const stopTask = harness.engine.stopCapture()
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(stopTask).resolves.toMatchObject({
      segment: {
        outputFormat: 'webm',
        outputPath: 'capture.webm',
        transcode: false,
        writeStreamErrored: true,
        writeStreamErrorMessage: expect.stringContaining(
          'Timed out waiting for recording stream',
        ),
      },
      streamOk: false,
    })
    expect(writeStream.destroyed).toBe(true)
  })

  it('resets attached partial capture idempotently', async () => {
    const tempDir = await createTempDir()
    const outputPath = path.join(tempDir, 'capture.webm')
    const harness = createHarness()
    await startCapture(harness, outputPath)
    harness.recorder.write('partial-media')

    await harness.engine.resetRecording()
    await harness.engine.resetRecording()

    expect(harness.session.isRecordingActive).toBe(false)
    expect(harness.recorder.stop).toHaveBeenCalledOnce()
    await expect(fs.stat(outputPath)).rejects.toThrow()
  })

  it('contains best-effort partial-file cleanup failures during reset', async () => {
    const tempDir = await createTempDir()
    const outputPath = path.join(tempDir, 'capture.webm')
    const unlink = vi.fn(async () => {
      throw new Error('file remains locked')
    })
    const harness = createHarness({
      fileSystem: { ...nodeFileSystem, unlink },
    })
    await startCapture(harness, outputPath)

    await expect(harness.engine.resetRecording()).resolves.toBeUndefined()

    expect(unlink).toHaveBeenCalledWith(outputPath)
  })

  it('coordinates close and switch window segment transitions', async () => {
    const delay = vi.fn(async () => {})
    const harness = createHarness({ clock: { ...systemClock, delay } })
    harness.session.beginRecording('windows')
    harness.session.setWindowHandle('window-1')
    const runSerialized = vi.fn(async (task: () => Promise<void>) => task())
    const operations: CaptureWindowOperations = {
      runSerialized,
      startRecording: vi.fn(async () => true),
      stopRecording: vi.fn(async () => {}),
    }

    await harness.engine.beforeWindowCommand('closeWindow', operations)
    await harness.engine.afterWindowCommand('closeWindow', operations)
    expect(operations.stopRecording).toHaveBeenCalledOnce()
    expect(operations.startRecording).toHaveBeenCalledOnce()
    expect(harness.session.currentSegment).toBe(2)
    expect(delay).toHaveBeenCalledWith(50)

    harness.session.setWindowHandle('window-2')
    harness.browser.getWindowHandle.mockResolvedValue('window-3')
    await harness.engine.afterWindowCommand('switchWindow', operations)
    expect(operations.stopRecording).toHaveBeenCalledTimes(2)
    expect(operations.startRecording).toHaveBeenCalledTimes(2)
    expect(harness.session.currentSegment).toBe(3)

    await harness.engine.afterWindowCommand('url', operations)
    expect(runSerialized).toHaveBeenCalledTimes(3)

    await harness.engine.beforeWindowCommand('switchWindow', operations)
    expect(runSerialized).toHaveBeenCalledTimes(3)

    harness.session.clearBrowser()
    await harness.engine.afterWindowCommand('switchWindow', operations)
    expect(runSerialized).toHaveBeenCalledTimes(4)
  })

  it('ignores missing handles and resumes an unchanged handle without a recorder', async () => {
    const harness = createHarness()
    harness.session.beginRecording('windows')
    harness.session.setWindowHandle('window-1')
    const operations: CaptureWindowOperations = {
      runSerialized: async (task) => task(),
      startRecording: vi.fn(async () => true),
      stopRecording: vi.fn(async () => {}),
    }

    harness.browser.getWindowHandle.mockRejectedValueOnce(
      new Error('window already closed'),
    )
    await harness.engine.afterWindowCommand('closeWindow', operations)
    expect(harness.session.currentWindowHandle).toBeUndefined()

    harness.session.setWindowHandle('window-1')
    harness.browser.getWindowHandle.mockResolvedValueOnce('window-1')
    await harness.engine.afterWindowCommand('switchWindow', operations)
    expect(operations.startRecording).toHaveBeenCalledOnce()
    harness.browser.getWindowHandle.mockRejectedValueOnce(
      new Error('target closed'),
    )
    await harness.engine.afterWindowCommand('newWindow', operations)

    expect(operations.stopRecording).toHaveBeenCalledOnce()
    expect(operations.startRecording).toHaveBeenCalledOnce()
  })

  it.each(['closed-handle', 'enumeration-failure'] as const)(
    'waits for a usable window after close with %s',
    async (mode) => {
      const harness = createHarness()
      harness.session.beginRecording('windows')
      harness.session.setWindowHandle('window-1')
      if (mode === 'enumeration-failure') {
        harness.browser.getWindowHandles.mockRejectedValueOnce(
          new Error('no context'),
        )
      } else {
        harness.browser.getWindowHandles.mockResolvedValueOnce(['window-2'])
      }
      const operations: CaptureWindowOperations = {
        runSerialized: async (task) => task(),
        startRecording: vi.fn(async () => true),
        stopRecording: vi.fn(async () => {}),
      }
      await harness.engine.afterWindowCommand('closeWindow', operations)
      expect(operations.startRecording).not.toHaveBeenCalled()
      expect(harness.session.currentWindowHandle).toBeUndefined()
      harness.browser.getWindowHandle.mockResolvedValueOnce('window-2')
      await harness.engine.afterWindowCommand('switchToWindow', operations)
      expect(operations.startRecording).toHaveBeenCalledOnce()
    },
  )

  it('does not restart an active recorder after WDIO automatically returns to a live tab', async () => {
    const outputPath = path.join(await createTempDir(), 'automatic-return.webm')
    const harness = createHarness()
    await startCapture(harness, outputPath)
    const operations: CaptureWindowOperations = {
      runSerialized: async (task) => task(),
      startRecording: vi.fn(async () => true),
      stopRecording: vi.fn(async () => {}),
    }
    await harness.engine.afterWindowCommand('closeWindow', operations)
    await harness.engine.afterWindowCommand('switchToWindow', operations)
    expect(operations.startRecording).not.toHaveBeenCalled()
    expect(operations.stopRecording).not.toHaveBeenCalled()
    await harness.engine.resetRecording()
  })

  it('contains target closure and focus failures during page lookup', async () => {
    const harness = createHarness()
    harness.browser.getWindowHandle = vi.fn(async () => {
      throw new Error('window closed')
    }) as never
    vi.mocked(harness.page.bringToFront).mockRejectedValueOnce(
      new Error('target closed'),
    )

    await expect(harness.engine.preparePage()).resolves.toEqual({
      page: harness.page,
      windowHandle: undefined,
    })
  })

  it.each([
    'Cannot find context with specified id',
    'Execution context was destroyed',
  ])(
    'recovers a navigation race during marker creation: %s',
    async (message) => {
      const delay = vi.fn(async () => {})
      const harness = createHarness({ clock: { ...systemClock, delay } })
      harness.browser.execute.mockRejectedValueOnce(new Error(message))
      await expect(harness.engine.preparePage()).resolves.toMatchObject({
        page: harness.page,
      })
      expect(delay).toHaveBeenCalledOnce()
      expect(harness.browser.execute).toHaveBeenCalledTimes(3) // retry and cleanup
      expect(Reflect.has(globalThis, PAGE_MARKER_PROPERTY)).toBe(false)
    },
  )

  it.each(['Cannot find context with specified id', 'session is closed'])(
    'bounds marker retries and preserves permanent errors: %s',
    async (message) => {
      const delay = vi.fn(async () => {})
      const harness = createHarness({ clock: { ...systemClock, delay } })
      const failure = new Error(message)
      harness.browser.execute.mockRejectedValue(failure)
      await expect(harness.engine.preparePage()).rejects.toBe(failure)
      expect(harness.browser.execute).toHaveBeenCalledTimes(
        message.startsWith('Cannot') ? 2 : 1,
      )
      expect(harness.startScreencast).not.toHaveBeenCalled()
    },
  )
})
