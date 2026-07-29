import type {
  Browser as PuppeteerBrowser,
  ScreenRecorder,
} from 'puppeteer-core'
import { describe, expect, it } from 'vitest'
import { CaptureSession } from '../../src/service/capture-session.js'
import type { ActiveSegment } from '../../src/service/constants.js'

const createSegment = (recordingPath = 'capture.webm') =>
  ({ recordingPath }) as ActiveSegment

describe('capture session', () => {
  it('owns browser and protocol connection state', () => {
    const session = new CaptureSession()
    const browser = { sessionId: 'session-1' } as never
    const puppeteerBrowser = { connected: true } as PuppeteerBrowser

    session.setBrowser(browser)
    session.setConnection(puppeteerBrowser, 'bidi+cdp')

    expect(session.browser).toBe(browser)
    expect(session.puppeteerBrowser).toBe(puppeteerBrowser)
    expect(session.protocol).toBe('bidi+cdp')

    session.clearBrowser()
    expect(session.browser).toBeUndefined()
    expect(session.puppeteerBrowser).toBeUndefined()
    expect(session.protocol).toBe('unsupported')
  })

  it('enforces one attached capture for an initialized recording', () => {
    const session = new CaptureSession()
    const recorder = { id: 'recorder' } as unknown as ScreenRecorder
    const segment = createSegment()

    expect(() =>
      session.attachCapture({
        dimensions: undefined,
        recorder,
        segment,
        windowHandle: undefined,
      }),
    ).toThrow('before recording is initialized')

    session.beginRecording('checkout')
    session.attachCapture({
      dimensions: { height: 720, width: 1280 },
      recorder,
      segment,
      windowHandle: 'window-1',
    })

    expect(session.hasCapture).toBe(true)
    expect(session.isRecordingActive).toBe(true)
    expect(session.recorder).toBe(recorder)
    expect(session.activeSegment).toBe(segment)
    expect(session.captureDimensions).toEqual({ height: 720, width: 1280 })
    expect(session.currentWindowHandle).toBe('window-1')
    expect(() =>
      session.attachCapture({
        dimensions: undefined,
        recorder,
        segment,
        windowHandle: undefined,
      }),
    ).toThrow('more than one capture')
    expect(() => session.beginRecording('other')).toThrow(
      'while capture is attached',
    )

    expect(session.detachCapture()).toEqual({ recorder, segment })
    expect(session.hasCapture).toBe(false)
    expect(session.isRecordingActive).toBe(true)
  })

  it('tracks segments and immutable retained-path snapshots', () => {
    const session = new CaptureSession()
    session.beginRecording('checkout')
    session.addRecordedPath('part1.webm')
    const firstSnapshot = session.recordedPaths

    expect(session.currentSegment).toBe(1)
    expect(session.advanceSegment()).toBe(2)
    expect(firstSnapshot).toEqual(['part1.webm'])
    expect(Object.isFrozen(firstSnapshot)).toBe(true)

    session.addRecordedPath('part2.webm')
    session.deleteRecordedPath('part1.webm')
    expect(session.recordedPaths).toEqual(['part2.webm'])
    session.clearRecordedPaths()
    expect(session.recordedPaths).toEqual([])
  })

  it('resets all recording invariants and returns any detached capture', () => {
    const session = new CaptureSession()
    const recorder = {} as ScreenRecorder
    const segment = createSegment()
    session.beginRecording('checkout')
    session.attachCapture({
      dimensions: { height: 400, width: 800 },
      recorder,
      segment,
      windowHandle: 'window-1',
    })
    session.addRecordedPath('part1.webm')
    session.setWindowHandle('window-2')

    expect(session.resetRecording()).toEqual({ recorder, segment })
    expect(session.currentSegment).toBe(0)
    expect(session.currentTestSlug).toBe('')
    expect(session.currentWindowHandle).toBeUndefined()
    expect(session.captureDimensions).toBeUndefined()
    expect(session.recordedPaths).toEqual([])
    expect(session.isRecordingActive).toBe(false)
    expect(() => session.advanceSegment()).toThrow(
      'without an active recording',
    )
  })
})
