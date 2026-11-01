import type { WriteStream } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { Browser } from 'webdriverio'
import { CaptureSession } from '../../src/service/capture-session.js'
import type { ActiveSegment } from '../../src/service/constants.js'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import type { CaptureStartOptions } from '../../src/service/puppeteer-capture-engine.js'
import {
  RecordingController,
  type RecordingControllerOptions,
} from '../../src/service/recording-controller.js'
import type { RecordingMediaCoordinator } from '../../src/service/recording-media-coordinator.js'
import type { ScreencastRecorder } from '../../src/service/screencast-recorder.js'
import type { WdioPuppeteerVideoServiceOptions } from '../../src/types.js'
import type { SlugMetadata } from '../../src/video-name-utils.js'

const METADATA: SlugMetadata = {
  fileToken: 'tabs_spec',
  hashInput: 'tabs|follows|0',
  retryToken: '',
  testNameToken: 'follows tabs',
}

const START_ERROR = new Error('capture start rejected')

const segmentFor = (recordingPath: string): ActiveSegment => ({
  onRecorderError: vi.fn(),
  onWriteStreamError: vi.fn(),
  outputFormat: 'webm',
  outputPath: recordingPath,
  recordingFormat: 'webm',
  recordingPath,
  transcode: false,
  transcodeOptions: { deleteOriginal: true },
  writeStream: {} as WriteStream,
  writeStreamDone: Promise.resolve(),
  writeStreamErrored: false,
})

/** A capture engine that attaches a capture to whichever tab it is asked for. */
const createHarness = (options: WdioPuppeteerVideoServiceOptions = {}) => {
  const resolved = resolveServiceConfiguration(options, 'linux')
  const session = new CaptureSession()
  session.setBrowser({} as Browser)
  const engine = {
    current: 'tab-a' as string | undefined,
    failNextStarts: 0,
    pageClosed: false,
    throwNextStarts: 0,
    starts: [] as string[],
  }
  const startCapture = vi.fn(async (start: CaptureStartOptions) => {
    const contextId = start.target?.contextId ?? engine.current
    engine.starts.push(
      `${contextId ?? 'none'}:${start.target?.reason ?? 'start'}`,
    )
    if (engine.throwNextStarts > 0) {
      engine.throwNextStarts -= 1
      throw START_ERROR
    }
    if (engine.failNextStarts > 0) {
      engine.failNextStarts -= 1
      return { started: false }
    }
    const output = await start.createOutput()
    session.attachCapture({
      recorder: {} as ScreencastRecorder,
      segment: segmentFor(output.recordingPath),
      windowHandle: contextId,
      ...(start.target?.reason ? { reason: start.target.reason } : {}),
    })
    return { started: true }
  })
  const captureEngine: RecordingControllerOptions['captureEngine'] = {
    afterWindowCommand: vi.fn(async () => {}),
    beforeWindowCommand: vi.fn(async () => {}),
    currentWindowHandle: vi.fn(async () => engine.current),
    get isRecordedPageClosed() {
      return engine.pageClosed
    },
    resetRecording: vi.fn(async () => {
      session.resetRecording()
    }),
    startCapture,
    stopCapture: vi.fn(async () => {
      session.detachCapture()
      engine.pageClosed = false
      // Retention discards the media here; these tests follow tabs only.
      return { segment: undefined, streamOk: true }
    }),
  }
  const controller = new RecordingController({
    captureEngine,
    captureSession: session,
    ffmpegRuntime: {
      ensureReady: vi.fn(async () => true),
      resolvePath: vi.fn(() => 'ffmpeg'),
      shouldTranscode: vi.fn(() => false),
    },
    getManifestRecorder: () => undefined,
    log: vi.fn(),
    maxSlugLength: resolved.maxSlugLength,
    media: {
      dropTasksForPaths: vi.fn(),
      pendingTaskCount: 0,
    } as unknown as RecordingMediaCoordinator,
    options: { ...resolved.options, outputDir: 'tab-videos' },
    recordingSlotScheduler: {
      acquire: vi.fn(async () => true),
      ownsGlobalRecordingSlot: false,
      ownsRecordingSlot: false,
      release: vi.fn(async () => {}),
    },
  })
  const tabs = () =>
    [...session.segmentTabs].map(
      ([segment, tab]) =>
        `${segment.toString()}:${tab.contextId}:${tab.reason}`,
    )
  return { controller, engine, session, startCapture, tabs }
}

// Output paths are reserved on disk; keep them in a temporary directory.
vi.mock('../../src/service/artifact-integrity.js', async (load) => {
  const actual =
    await load<typeof import('../../src/service/artifact-integrity.js')>()
  return { ...actual, reserveArtifactPath: async (target: string) => target }
})

describe('RecordingController tab following', () => {
  it('records each followed tab in its own segment', async () => {
    const { controller, session, tabs } = createHarness()
    await controller.startForMetadata(METADATA, 0)

    await controller.followContext('tab-b', 'command')
    await controller.followContext('tab-b', 'command')
    await controller.followContext('tab-a', 'switch-to-window')

    expect(tabs()).toEqual([
      '1:tab-a:start',
      '2:tab-b:command',
      '3:tab-a:switch-to-window',
    ])
    expect(controller.recordedContextId).toBe('tab-a')
    expect(controller.hasActiveCapture).toBe(true)
    expect(session.currentSegment).toBe(3)
  })

  it('reports the tabs of the segments whose files were kept', async () => {
    const { controller, session } = createHarness()
    await controller.startForMetadata(METADATA, 0)
    await controller.followContext('tab-b', 'command')
    await controller.followContext('tab-a', 'switch-to-window')
    const slug = session.currentTestSlug
    // Part 2 produced no media, so it was never retained.
    session.addRecordedPath(`tab-videos/${slug}_part1.webm`)
    session.addRecordedPath(`tab-videos/${slug}_part3.webm`)

    const finalized = await controller.finalizeMedia(true, true)

    expect(
      [...(finalized.tabs ?? [])].map(
        ([part, tab]) => `${part.toString()}:${tab.contextId}:${tab.reason}`,
      ),
    ).toEqual(['1:tab-a:start', '3:tab-a:switch-to-window'])
  })

  it('reports no tabs when no segment file was kept', async () => {
    const { controller } = createHarness()
    await controller.startForMetadata(METADATA, 0)

    await expect(
      controller.finalizeMedia(true, true),
    ).resolves.not.toHaveProperty('tabs')
  })

  it('retries a tab that failed to record a bounded number of times', async () => {
    const { controller, engine, session, tabs } = createHarness()
    await controller.startForMetadata(METADATA, 0)
    engine.failNextStarts = 5

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await controller.followContext('tab-b', 'command')
    }

    expect(engine.starts).toEqual([
      'tab-a:start',
      'tab-b:command',
      'tab-b:command',
    ])
    // Failed starts reuse the segment number instead of leaving gaps.
    expect(session.currentSegment).toBe(2)
    expect(controller.hasActiveCapture).toBe(false)

    engine.failNextStarts = 0
    await controller.followContext('tab-a', 'command')
    expect(tabs()).toEqual(['1:tab-a:start', '2:tab-a:command'])
  })

  it('keeps a tab’s retry budget when the test switches away and back', async () => {
    const { controller, engine, tabs } = createHarness()
    await controller.startForMetadata(METADATA, 0)
    engine.failNextStarts = 2
    await controller.followContext('tab-b', 'command')
    await controller.followContext('tab-b', 'command')

    await controller.followContext('tab-a', 'command')
    engine.failNextStarts = 5
    await controller.followContext('tab-b', 'command')
    await controller.followContext('tab-b', 'command')

    expect(engine.starts).toEqual([
      'tab-a:start',
      'tab-b:command',
      'tab-b:command',
      'tab-a:command',
    ])
    // Tab A is not filmed while the test drives B.
    expect(controller.recordedContextId).toBe('tab-b')
    expect(controller.hasActiveCapture).toBe(false)
    expect(tabs()).toEqual(['1:tab-a:start', '2:tab-a:command'])
    const finalized = await controller.finalizeMedia(true, true)
    expect(finalized.captureFailure).toContain('tab-b')
  })

  it('reports a gap that a later recording of the tab does not erase', async () => {
    const { controller, engine, tabs } = createHarness()
    await controller.startForMetadata(METADATA, 0)
    engine.failNextStarts = 1

    await controller.followContext('tab-b', 'command')
    await controller.followContext('tab-b', 'command')

    expect(tabs()).toEqual(['1:tab-a:start', '2:tab-b:command'])
    expect(controller.hasActiveCapture).toBe(true)
    const finalized = await controller.finalizeMedia(true, true)
    expect(finalized.captureFailure).toBe(
      'Recording could not start on the tab the test is driving (tab-b); the recording is incomplete.',
    )
  })

  it('reports no gap when the browser rejects a switch it could not record', async () => {
    const { controller, engine, tabs } = createHarness()
    await controller.startForMetadata(METADATA, 0)
    engine.failNextStarts = 1

    await controller.followContext('tab-closed', 'switch-to-window')
    await controller.followContext('tab-a', 'switch-failed')

    expect(tabs()).toEqual(['1:tab-a:start', '2:tab-a:switch-failed'])
    const finalized = await controller.finalizeMedia(true, true)
    expect(finalized).not.toHaveProperty('captureFailure')
  })

  it.each([
    ['the next command', true],
    ['the end of the test', false],
  ])(
    'reports a gap for an accepted switch it could not record, at %s',
    async (_moment, nextCommand) => {
      const { controller, engine } = createHarness()
      await controller.startForMetadata(METADATA, 0)
      engine.failNextStarts = 2

      await controller.followContext('tab-b', 'switch-to-window')
      if (nextCommand) {
        await controller.followContext('tab-b', 'command')
      }

      const finalized = await controller.finalizeMedia(true, true)
      expect(finalized.captureFailure).toContain('tab-b')
    },
  )

  it.each(['warn', 'error'] as const)(
    'reports a gap when starting a driven tab throws, under the %s policy',
    async (failurePolicy) => {
      const { controller, engine, tabs } = createHarness({ failurePolicy })
      await controller.startForMetadata(METADATA, 0)
      engine.throwNextStarts = 1

      const following = controller.followContext('tab-b', 'command')
      if (failurePolicy === 'error') {
        await expect(following).rejects.toBe(START_ERROR)
      } else {
        await expect(following).resolves.toBeUndefined()
      }
      expect(controller.recordedContextId).toBe('tab-b')
      expect(controller.hasActiveCapture).toBe(false)

      // Recording the next tab does not erase the gap.
      await controller.followContext('tab-a', 'command')
      expect(controller.hasActiveCapture).toBe(true)
      expect(tabs()).toEqual(['1:tab-a:start', '2:tab-a:command'])
      const finalized = await controller.finalizeMedia(true, true)
      expect(finalized.captureFailure).toContain('tab-b')
    },
  )

  it('counts thrown starts against a tab’s retry budget across tab changes', async () => {
    const { controller, engine } = createHarness({ failurePolicy: 'error' })
    await controller.startForMetadata(METADATA, 0)
    engine.throwNextStarts = 1
    await expect(controller.followContext('tab-b', 'command')).rejects.toBe(
      START_ERROR,
    )
    await controller.followContext('tab-a', 'command')
    engine.failNextStarts = 1
    await controller.followContext('tab-b', 'command')

    await controller.followContext('tab-a', 'command')
    await controller.followContext('tab-b', 'command')

    expect(engine.starts).toEqual([
      'tab-a:start',
      'tab-b:command',
      'tab-a:command',
      'tab-b:command',
      'tab-a:command',
    ])
    expect(controller.recordedContextId).toBe('tab-b')
    expect(controller.hasActiveCapture).toBe(false)
  })

  it('reports no gap when a switch whose start threw is rejected', async () => {
    const { controller, engine, tabs } = createHarness({
      failurePolicy: 'error',
    })
    await controller.startForMetadata(METADATA, 0)
    engine.throwNextStarts = 1

    await expect(
      controller.followContext('tab-closed', 'switch-to-window'),
    ).rejects.toBe(START_ERROR)
    await controller.followContext('tab-a', 'switch-failed')

    expect(tabs()).toEqual(['1:tab-a:start', '2:tab-a:switch-failed'])
    const finalized = await controller.finalizeMedia(true, true)
    expect(finalized).not.toHaveProperty('captureFailure')
  })

  it.each([
    ['rejected', false],
    ['accepted', true],
  ])(
    'treats a %s switch to a tab out of retries as a gap only once accepted',
    async (_outcome, accepted) => {
      const { controller, engine, tabs } = createHarness()
      await controller.startForMetadata(METADATA, 0)
      for (let attempt = 0; attempt < 2; attempt += 1) {
        engine.failNextStarts = 1
        await controller.followContext('tab-b', 'switch-to-window')
        await controller.followContext('tab-a', 'switch-failed')
      }

      // Out of retries: the tab is selected without another start.
      await controller.followContext('tab-b', 'switch-to-window')
      expect(engine.starts).toHaveLength(5)
      expect(controller.recordedContextId).toBe('tab-b')
      if (accepted) {
        await controller.followContext('tab-b', 'command')
      } else {
        await controller.followContext('tab-a', 'switch-failed')
      }

      expect(tabs()).toEqual([
        '1:tab-a:start',
        '2:tab-a:switch-failed',
        '3:tab-a:switch-failed',
        ...(accepted ? [] : ['4:tab-a:switch-failed']),
      ])
      const finalized = await controller.finalizeMedia(true, true)
      if (accepted) {
        expect(finalized.captureFailure).toContain('tab-b')
      } else {
        expect(finalized).not.toHaveProperty('captureFailure')
      }
    },
  )

  it('starts a new recording with a full retry budget and no gap', async () => {
    const { controller, engine } = createHarness()
    await controller.startForMetadata(METADATA, 0)
    engine.failNextStarts = 2
    await controller.followContext('tab-b', 'command')
    await controller.followContext('tab-b', 'command')
    await controller.finalizeMedia(true, true)
    await controller.reset()

    engine.current = 'tab-b'
    await controller.startForMetadata(METADATA, 1)
    await controller.followContext('tab-c', 'command')
    await controller.followContext('tab-b', 'command')

    expect(engine.starts.slice(3)).toEqual([
      'tab-b:start',
      'tab-c:command',
      'tab-b:command',
    ])
    const finalized = await controller.finalizeMedia(true, true)
    expect(finalized).not.toHaveProperty('captureFailure')
  })

  it('records the tab again when the browser refuses to close it', async () => {
    const { controller, tabs } = createHarness()
    await controller.startForMetadata(METADATA, 0)

    await controller.stopClosingContext('tab-a')
    expect(controller.hasActiveCapture).toBe(false)
    // A command on the tab while its close is pending does not restart it.
    await controller.followContext('tab-a', 'command')
    expect(controller.hasActiveCapture).toBe(false)

    await controller.recoverFailedClose('tab-a')
    await controller.recoverFailedClose('tab-a')

    expect(tabs()).toEqual(['1:tab-a:start', '2:tab-a:close-failed'])
  })

  it('continues on the current tab after a close succeeds', async () => {
    const { controller, engine, tabs } = createHarness()
    await controller.startForMetadata(METADATA, 0)
    await controller.followContext('tab-b', 'command')

    await controller.stopClosingContext('tab-b')
    await controller.resumeAfterClose()
    await controller.resumeAfterClose()

    expect(tabs()).toEqual([
      '1:tab-a:start',
      '2:tab-b:command',
      '3:tab-a:tab-closed',
    ])
    expect(engine.starts.at(-1)).toBe('tab-a:tab-closed')
  })

  it('continues after a Classic close that closed the page under capture', async () => {
    const { controller, engine, tabs } = createHarness()
    await controller.startForMetadata(METADATA, 0)
    await controller.followContext('tab-b', 'command')

    engine.pageClosed = true
    await controller.resumeAfterClose()

    expect(tabs()).toEqual([
      '1:tab-a:start',
      '2:tab-b:command',
      '3:tab-a:tab-closed',
    ])
  })

  it('waits for the next command when no tab is current after a close', async () => {
    const { controller, engine, tabs } = createHarness()
    await controller.startForMetadata(METADATA, 0)

    await controller.stopClosingContext('tab-a')
    engine.current = undefined
    await controller.resumeAfterClose()
    expect(controller.hasActiveCapture).toBe(false)

    // A stale current window naming the closed tab is not recorded either.
    await controller.stopClosingContext('tab-a')
    engine.current = 'tab-a'
    await controller.resumeAfterClose()
    expect(controller.hasActiveCapture).toBe(false)

    await controller.followContext('tab-b', 'command')
    expect(tabs()).toEqual(['1:tab-a:start', '2:tab-b:command'])
  })

  it('ignores closes and recoveries for tabs it is not recording', async () => {
    const { controller, engine } = createHarness()
    await controller.startForMetadata(METADATA, 0)

    await controller.stopClosingContext('tab-b')
    await controller.recoverFailedClose('tab-b')
    await controller.resumeAfterClose()

    expect(controller.hasActiveCapture).toBe(true)
    expect(engine.starts).toEqual(['tab-a:start'])
  })

  it('leaves tabs alone without a recording or with window changes ignored', async () => {
    const idle = createHarness()
    await idle.controller.followContext('tab-b', 'command')
    await idle.controller.stopClosingContext('tab-a')
    await idle.controller.recoverFailedClose('tab-a')
    await idle.controller.resumeAfterClose()
    expect(idle.startCapture).not.toHaveBeenCalled()

    const ignoring = createHarness({ recording: { windowChanges: 'ignore' } })
    await ignoring.controller.startForMetadata(METADATA, 0)
    await ignoring.controller.followContext('tab-b', 'command')
    expect(ignoring.engine.starts).toEqual(['tab-a:start'])
  })
})
