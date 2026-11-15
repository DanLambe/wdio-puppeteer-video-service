import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Browser } from 'webdriverio'
import { nodeFileSystem } from '../../src/service/boundaries.js'
import { CaptureSession } from '../../src/service/capture-session.js'
import type { ScreencastSpool } from '../../src/service/frame-sink.js'
import type { ServiceLogger } from '../../src/service/logging.js'
import type { MediaPipeline } from '../../src/service/media-pipeline.js'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import type {
  CaptureStartOptions,
  CaptureStopResult,
} from '../../src/service/puppeteer-capture-engine.js'
import {
  RecordingController,
  type RecordingControllerOptions,
} from '../../src/service/recording-controller.js'
import { RecordingMediaCoordinator } from '../../src/service/recording-media-coordinator.js'
import type { ScreencastRecorder } from '../../src/service/screencast-recorder.js'
import type { WdioPuppeteerVideoServiceOptions } from '../../src/types.js'
import type { SlugMetadata } from '../../src/video-name-utils.js'

const METADATA: SlugMetadata = {
  fileToken: 'deferred_spec',
  hashInput: 'deferred|spools|0',
  retryToken: '',
  testNameToken: 'spools segments',
}

const SETTINGS = {
  canvas: { height: 600, width: 800 },
  format: 'webm' as const,
  quality: 30,
  scale: 1,
}

type LogCall = Readonly<{
  level: Parameters<ServiceLogger>[0]
  message: string
}>

let outputDir = ''

beforeEach(async () => {
  outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-deferred-life-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(outputDir, { force: true, recursive: true })
})

const exists = async (filePath: string): Promise<boolean> =>
  fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false)

/** Every file under the output directory, relative and sorted. */
const listTree = async (): Promise<string[]> =>
  (await fs.readdir(outputDir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(outputDir, path.join(entry.parentPath, entry.name))
        .replaceAll('\\', '/'),
    )
    .sort((left, right) => left.localeCompare(right))

interface HarnessOptions {
  readonly service?: WdioPuppeteerVideoServiceOptions
  readonly spoolStorage?: boolean
}

/**
 * The real session, controller and media coordinator over a fake engine that
 * writes real files: a live segment's encoder output at its reserved path, a
 * deferred segment's frames at its spool path.
 */
const createHarness = (harnessOptions: HarnessOptions = {}) => {
  const resolved = resolveServiceConfiguration(
    { ...harnessOptions.service, outputDir },
    'linux',
  )
  const session = new CaptureSession()
  session.setBrowser({} as Browser)
  const logs: LogCall[] = []
  const log: ServiceLogger = (level, message) => {
    logs.push({ level, message })
  }
  const engine = { current: 'tab-a', uncleanParts: new Set<number>() }
  const spools = new Map<number, ScreencastSpool>()
  const startCapture = vi.fn(async (start: CaptureStartOptions) => {
    const output = await start.createOutput()
    if (start.spoolPath === undefined) {
      await fs.writeFile(output.recordingPath, `frames-${output.recordingPath}`)
    } else {
      await fs.mkdir(path.dirname(start.spoolPath), { recursive: true })
      await fs.writeFile(start.spoolPath, 'spooled-frames', { flag: 'wx' })
      spools.set(session.currentSegment, {
        path: start.spoolPath,
        settings: SETTINGS,
      })
    }
    session.attachCapture({
      recorder: {} as ScreencastRecorder,
      segment: {
        outputFormat: output.outputFormat,
        outputPath: output.outputPath,
        recordingFormat: output.recordingFormat,
        recordingPath: output.recordingPath,
        transcode: output.transcodeEnabled,
        transcodeOptions: start.transcodeOptions,
      },
      windowHandle: start.target?.contextId ?? engine.current,
      ...(start.target?.reason ? { reason: start.target.reason } : {}),
    })
    return { started: true }
  })
  const stopCapture = vi.fn(
    async (
      stop: Readonly<{ discard?: boolean }> = {},
    ): Promise<CaptureStopResult> => {
      const part = session.currentSegment
      const { segment } = session.detachCapture()
      const spool = spools.get(part)
      spools.delete(part)
      if (!segment) {
        return { capturedSeconds: 0, segment: undefined, streamOk: false }
      }
      if (stop.discard) {
        await fs.rm(spool?.path ?? segment.recordingPath, { force: true })
        return { capturedSeconds: 2, segment: undefined, streamOk: true }
      }
      const spooled = spool ? { spool } : {}
      if (!engine.uncleanParts.has(part)) {
        return { capturedSeconds: 2, segment, ...spooled, streamOk: true }
      }
      segment.transcode = false
      segment.outputPath = segment.recordingPath
      segment.outputFormat = segment.recordingFormat
      return {
        capturedSeconds: 2,
        incompleteReason: 'The frame spool could not be written: ENOSPC',
        segment,
        ...spooled,
        streamOk: false,
      }
    },
  )
  const discardSpool = vi.fn(async (spool: ScreencastSpool) => {
    await fs.rm(spool.path, { force: true })
  })
  const resetRecording = vi.fn(async () => {
    const spool = spools.get(session.currentSegment)
    spools.clear()
    session.detachCapture()
    session.resetRecording()
    return spool ? { spool } : {}
  })
  const captureEngine: RecordingControllerOptions['captureEngine'] = {
    afterWindowCommand: vi.fn(async () => {}),
    beforeWindowCommand: vi.fn(async () => {}),
    currentWindowHandle: vi.fn(async () => engine.current),
    discardSpool,
    isRecordedPageClosed: false,
    resetRecording,
    startCapture,
    stopCapture,
  }
  const ffmpegRuntime: RecordingControllerOptions['ffmpegRuntime'] = {
    ensureReady: vi.fn(async () => true),
    resolvePath: vi.fn(() => 'ffmpeg'),
    shouldTranscode: vi.fn(
      (format) =>
        format === 'mp4' && resolved.options.processing.transcode.enabled,
    ),
  }
  const transcode = vi.fn<MediaPipeline['transcode']>(async (request) => {
    await fs.writeFile(request.outputPath, 'h264')
    if (request.deleteOriginal) {
      await fs.rm(request.inputPath, { force: true })
    }
    return request.outputPath
  })
  const merge = vi.fn<MediaPipeline['merge']>(async (request) => {
    await fs.writeFile(request.mergedPath, 'merged')
    return request.mergedPath
  })
  const media = new RecordingMediaCoordinator({
    captureSession: session,
    ffmpegRuntime,
    fileSystem: nodeFileSystem,
    getManifestRecorder: () => undefined,
    log,
    mediaPipeline: { merge, reportFailure: vi.fn(), transcode },
    options: resolved.options,
  })
  const finalizeSegment = vi.spyOn(media, 'finalizeSegment')
  let uuidIndex = 0
  const spoolDirectory = path.join(outputDir, '.wdio-video-spool', 'run-1')
  const controller = new RecordingController({
    captureEngine,
    captureSession: session,
    ffmpegRuntime,
    getManifestRecorder: () => undefined,
    log,
    maxSlugLength: resolved.maxSlugLength,
    media,
    options: resolved.options,
    recordingSlotScheduler: {
      acquire: vi.fn(async () => true),
      ownsGlobalRecordingSlot: false,
      ownsRecordingSlot: false,
      release: vi.fn(async () => {}),
    },
    ...(harnessOptions.spoolStorage === false
      ? {}
      : {
          spoolStorage: {
            directory: spoolDirectory,
            uuid: () => {
              uuidIndex += 1
              return `uuid-${uuidIndex.toString()}`
            },
          },
        }),
  })
  /** Records three tabs: a, then b, then a again. */
  const recordThreeTabs = async (retryCount = 0): Promise<void> => {
    await controller.startForMetadata(METADATA, retryCount)
    await controller.followContext('tab-b', 'command')
    await controller.followContext('tab-a', 'switch-to-window')
  }
  const spoolOf = (part: number): string =>
    path.join(
      spoolDirectory,
      `${session.currentTestSlug}_part${part.toString()}.uuid-${part.toString()}.mkv`,
    )
  return {
    controller,
    discardSpool,
    engine,
    finalizeSegment,
    logs,
    media,
    recordThreeTabs,
    resetRecording,
    session,
    spoolOf,
    startCapture,
    transcode,
  }
}

const spoolPathsOf = (
  harness: ReturnType<typeof createHarness>,
): (string | undefined)[] =>
  harness.startCapture.mock.calls.map(([start]) => start.spoolPath)

describe('deferred segment capture', () => {
  it.each([
    [{ capture: { encoding: 'deferred' } }, 0, true],
    [{ capture: { encoding: 'live' } }, 0, false],
    [{}, 0, false],
    [{ capture: { encoding: 'auto' } }, 0, true],
    [{ capture: { encoding: 'auto' }, recording: { retain: 'all' } }, 0, false],
    [
      { capture: { encoding: 'auto' }, recording: { retain: 'retries' } },
      0,
      true,
    ],
    [
      { capture: { encoding: 'auto' }, recording: { retain: 'retries' } },
      1,
      false,
    ],
  ] as const)(
    'spools every part for %j on retry %i: %s',
    async (service, retryCount, spooled) => {
      const harness = createHarness({ service })

      await harness.recordThreeTabs(retryCount)

      expect(spoolPathsOf(harness)).toEqual(
        spooled
          ? [harness.spoolOf(1), harness.spoolOf(2), harness.spoolOf(3)]
          : [undefined, undefined, undefined],
      )
    },
  )

  it('encodes live without spool storage, whatever the option says', async () => {
    const harness = createHarness({
      service: { capture: { encoding: 'deferred' } },
      spoolStorage: false,
    })

    await harness.recordThreeTabs()

    expect(spoolPathsOf(harness)).toEqual([undefined, undefined, undefined])
  })

  it('reserves no output for a spooled part and holds its spool when it stops', async () => {
    const harness = createHarness({
      service: { capture: { encoding: 'deferred' } },
    })

    await harness.recordThreeTabs()

    const held = harness.session.heldSegments
    expect(held.map((segment) => segment.part)).toEqual([1, 2])
    expect(held.map((segment) => segment.spool?.path)).toEqual([
      harness.spoolOf(1),
      harness.spoolOf(2),
    ])
    expect(held.map((segment) => segment.tab?.contextId)).toEqual([
      'tab-a',
      'tab-b',
    ])
    expect(held.every((segment) => segment.clean)).toBe(true)
    expect(held.map((segment) => segment.capturedSeconds)).toEqual([2, 2])
    // The planned outputs are only names: nothing was reserved at them, and a
    // spool is not one of the recording's media files.
    expect(harness.session.filePaths).toEqual([])
    expect(
      (await fs.readdir(outputDir)).filter((name) => name.endsWith('.webm')),
    ).toEqual([])
    expect(harness.finalizeSegment).not.toHaveBeenCalled()
  })

  it('deletes every spool of a discarded recording and processes nothing', async () => {
    const harness = createHarness({
      service: { capture: { encoding: 'deferred' } },
    })
    await harness.recordThreeTabs()
    const spools = [harness.spoolOf(1), harness.spoolOf(2)]

    const finalized = await harness.controller.finalizeMedia(true, false)
    await harness.controller.reset()

    expect(finalized).toEqual({ deferred: false, paths: [] })
    // Two held spools are discarded by the controller; the third part's
    // capture is aborted and deleted by the engine.
    expect(
      harness.discardSpool.mock.calls.map(([spool]) => spool.path),
    ).toEqual(spools)
    expect(harness.finalizeSegment).not.toHaveBeenCalled()
    expect(harness.transcode).not.toHaveBeenCalled()
    expect(harness.session.heldSegments).toEqual([])
    expect(await listTree()).toEqual([])
  })

  it('reports an unclean spool when it stops and holds it as unclean', async () => {
    const harness = createHarness({
      service: { capture: { encoding: 'deferred' } },
    })
    harness.engine.uncleanParts.add(1)
    await harness.recordThreeTabs()

    const [first] = harness.session.heldSegments
    expect(first).toMatchObject({
      clean: false,
      incompleteReason: 'The frame spool could not be written: ENOSPC',
      spool: { path: harness.spoolOf(1) },
    })
    expect(harness.logs).toContainEqual({
      level: 'warn',
      message: `[WdioPuppeteerVideoService] Recording stream did not finish cleanly for: ${harness.spoolOf(1)} (The frame spool could not be written: ENOSPC)`,
    })
  })

  it('keeps a discarded spooled recording reported as incomplete', async () => {
    const harness = createHarness({
      service: { capture: { encoding: 'deferred' } },
    })
    harness.engine.uncleanParts.add(1)
    await harness.recordThreeTabs()

    const finalized = await harness.controller.finalizeMedia(true, false)

    expect(finalized.captureFailure).toContain(harness.spoolOf(1))
    expect(await exists(harness.spoolOf(1))).toBe(false)
  })
})
