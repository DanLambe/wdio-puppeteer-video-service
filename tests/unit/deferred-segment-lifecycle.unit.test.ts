import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Browser } from 'webdriverio'
import {
  type DiskSpaceBoundary,
  nodeFileSystem,
  systemClock,
} from '../../src/service/boundaries.js'
import { CaptureSession } from '../../src/service/capture-session.js'
import {
  DeferredEncoder,
  type DeferredEncoderOptions,
} from '../../src/service/deferred-encode.js'
import type { FfmpegRunResult } from '../../src/service/ffmpeg-runner.js'
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
import {
  DEFAULT_SPOOL_LIMITS,
  type SpoolLimits,
} from '../../src/service/spool-budget.js'
import {
  type RecordingAllurePort,
  type RecordingManifestPort,
  WorkerRecordingCoordinator,
} from '../../src/service/worker-recording-coordinator.js'
import type { WdioPuppeteerVideoServiceOptions } from '../../src/types.js'
import type { SlugMetadata } from '../../src/video-name-utils.js'
import { createControlledClock } from '../utils/controlled-clock.js'
import { spoolName, testSpoolUuid } from '../utils/spool-fixtures.js'

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
  readonly encoder?: Partial<
    Pick<DeferredEncoderOptions, 'clock' | 'limits' | 'linkFile'>
  >
  readonly service?: WdioPuppeteerVideoServiceOptions
  readonly spoolDiskSpace?: DiskSpaceBoundary
  readonly spoolLimits?: SpoolLimits
  readonly spoolStorage?: boolean
  readonly spoolUuid?: () => string
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
  const engine = {
    current: 'tab-a',
    // Parts captured live although the recording spools: a promoted segment.
    liveParts: new Set<number>(),
    uncleanParts: new Set<number>(),
  }
  const spools = new Map<number, ScreencastSpool>()
  const startCapture = vi.fn(async (start: CaptureStartOptions) => {
    const output = await start.createOutput()
    if (engine.liveParts.has(session.currentSegment)) {
      await fs.writeFile(
        output.recordingPath,
        `frames-${output.recordingPath}`,
        {
          flag: 'wx',
        },
      )
    } else if (start.spoolPath === undefined) {
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
    const { segment } = session.detachCapture()
    session.resetRecording()
    return spool && segment
      ? { spooled: { plannedPath: segment.recordingPath, spool } }
      : {}
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
  // Every slot taken or given back, in order, to show leases never nest.
  const leases: string[] = []
  let recordingSlotOwned = false
  // How the next spool encode ends; FFmpeg writes the output by default.
  const encodes = {
    accepting: true,
    failParts: new Set<number>(),
    // Replaces the run: how it ends, as the runner would report it.
    run: undefined as
      | ((signal: AbortSignal | undefined) => Promise<FfmpegRunResult>)
      | undefined,
  }
  const encodeFfmpeg: DeferredEncoderOptions['ffmpeg'] = {
    get isAcceptingWork() {
      return encodes.accepting
    },
    resolvePath: () => 'ffmpeg',
    run: vi.fn(async (args: string[], _operation: string, overrides = {}) => {
      if (encodes.run) {
        const result = await encodes.run(overrides.signal)
        overrides.onResult?.(result)
        return false
      }
      const outputPath = args.at(-1) ?? ''
      const part = Number(/_part(\d+)\./u.exec(outputPath)?.[1])
      if (encodes.failParts.has(part)) {
        overrides.onResult?.({
          code: 1,
          diagnostic: 'Invalid data found when processing input',
          kind: 'exited',
          signal: null,
        })
        return false
      }
      await fs.writeFile(outputPath, 'vp9')
      overrides.onResult?.({
        code: 0,
        diagnostic: '',
        kind: 'exited',
        signal: null,
      })
      return true
    }),
    withPostProcessSlot: vi.fn(async (_operation, task, admission) => {
      if (!encodes.accepting || admission?.signal.aborted) {
        return undefined
      }
      leases.push(
        recordingSlotOwned
          ? 'processing slot while recording'
          : 'processing slot',
      )
      return task()
    }) as DeferredEncoderOptions['ffmpeg']['withPostProcessSlot'],
  }
  const encoder = new DeferredEncoder({
    clock: systemClock,
    concurrency: resolved.options.concurrency,
    ffmpeg: encodeFfmpeg,
    fileSystem: nodeFileSystem,
    log,
    ...harnessOptions.encoder,
  })
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
      acquire: vi.fn(async () => {
        recordingSlotOwned = true
        leases.push('recording slot')
        return true
      }),
      ownsGlobalRecordingSlot: false,
      get ownsRecordingSlot() {
        return recordingSlotOwned
      },
      release: vi.fn(async () => {
        if (recordingSlotOwned) {
          leases.push('recording slot released')
        }
        recordingSlotOwned = false
      }),
    },
    ...(harnessOptions.spoolStorage === false
      ? {}
      : {
          spoolStorage: {
            directory: spoolDirectory,
            ...(harnessOptions.spoolDiskSpace
              ? { diskSpace: harnessOptions.spoolDiskSpace }
              : {}),
            encoder,
            ...(harnessOptions.spoolLimits
              ? { limits: harnessOptions.spoolLimits }
              : {}),
            uuid:
              harnessOptions.spoolUuid ??
              (() => {
                uuidIndex += 1
                return testSpoolUuid(uuidIndex)
              }),
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
    path.join(spoolDirectory, spoolName(session.currentTestSlug, part, part))
  return {
    controller,
    discardSpool,
    encodeFfmpeg,
    encodes,
    engine,
    finalizeSegment,
    leases,
    logs,
    media,
    merge,
    recordThreeTabs,
    resetRecording,
    resolved,
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

describe('the spool budget of a recording', () => {
  const budgetsOf = (harness: ReturnType<typeof createHarness>) =>
    harness.startCapture.mock.calls.map(([start]) => start.budget)

  it('gives every spooled part the same budget, built from the storage limits and disk', async () => {
    const limits = { ...DEFAULT_SPOOL_LIMITS, promoteBytes: 1_234 }
    const diskSpace = { freeBytes: vi.fn(async () => 5) }
    const harness = createHarness({
      service: { capture: { encoding: 'deferred' } },
      spoolDiskSpace: diskSpace,
      spoolLimits: limits,
    })

    await harness.recordThreeTabs()

    const [first, second, third] = budgetsOf(harness)
    expect(first).toBeDefined()
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(first?.limits).toBe(limits)
    await expect(first?.readFreeBytes('/spool')).resolves.toBe(5)
    expect(diskSpace.freeBytes).toHaveBeenCalledWith('/spool')
  })

  it('defaults to the default limits', async () => {
    const harness = createHarness({
      service: { capture: { encoding: 'deferred' } },
    })

    await harness.recordThreeTabs()

    expect(budgetsOf(harness)[0]?.limits).toBe(DEFAULT_SPOOL_LIMITS)
  })

  it('starts a new recording with a new, empty budget', async () => {
    const harness = createHarness({
      service: { capture: { encoding: 'deferred' } },
    })
    await harness.controller.startForMetadata(METADATA, 0)
    const first = budgetsOf(harness)[0]
    first?.markPromoted()
    await harness.controller.finalizeMedia(true, false)
    await harness.controller.reset()

    await harness.controller.startForMetadata(METADATA, 0)

    const second = budgetsOf(harness)[1]
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    expect(second?.promoted).toBe(false)
    // The new recording spools again.
    expect(spoolPathsOf(harness)[1]).toBeDefined()
  })

  it('starts the later parts live once the recording has used its spool allowance', async () => {
    const harness = createHarness({
      service: { capture: { encoding: 'deferred' } },
    })
    await harness.controller.startForMetadata(METADATA, 0)
    // What a segment's budget does when the recording's spools reach the
    // promote threshold, wherever their bytes are.
    budgetsOf(harness)[0]?.markPromoted()
    await harness.controller.followContext('tab-b', 'command')
    await harness.controller.followContext('tab-a', 'switch-to-window')

    expect(spoolPathsOf(harness)).toEqual([
      harness.spoolOf(1),
      undefined,
      undefined,
    ])
    expect(budgetsOf(harness)[1]).toBeUndefined()
    // The earlier spool stays until the recording's end.
    expect(
      harness.session.heldSegments.map((held) => held.spool?.path),
    ).toEqual([harness.spoolOf(1), undefined])
  })

  it('lets go of the budget once the recording is reset', async () => {
    const harness = createHarness({
      service: { capture: { encoding: 'deferred' } },
    })
    await harness.controller.startForMetadata(METADATA, 0)
    await harness.controller.followContext('tab-b', 'command')
    expect(budgetsOf(harness)[1]).toBe(budgetsOf(harness)[0])
    await harness.controller.finalizeMedia(true, false)
    await harness.controller.reset()

    // The controller holds no budget between recordings.
    expect(
      (harness.controller as unknown as { spoolBudget: unknown }).spoolBudget,
    ).toBeUndefined()
  })

  it('gives a live recording no budget', async () => {
    const harness = createHarness()

    await harness.recordThreeTabs()

    expect(budgetsOf(harness)).toEqual([undefined, undefined, undefined])
  })
})

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

  it('records live rather than spool under a name orphan recovery would not recognize', async () => {
    const harness = createHarness({
      service: { capture: { encoding: 'deferred' } },
      spoolUuid: () => 'not-a-uuid',
    })

    await harness.recordThreeTabs()

    expect(spoolPathsOf(harness)).toEqual([undefined, undefined, undefined])
    expect(harness.logs).toContainEqual({
      level: 'debug',
      message:
        '[WdioPuppeteerVideoService] Recording segment 1 live: its spool name would not be recognized by orphan recovery.',
    })
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

const MP4 = {
  format: 'mp4',
  transcode: { enabled: true, deleteOriginal: true },
} as const

const DEFERRED = { encoding: 'deferred' } as const

/** The worker coordinator over a harness, recording what it reports. */
const createReportingCoordinator = (
  harness: ReturnType<typeof createHarness>,
) => {
  const completeCurrent = vi.fn<RecordingManifestPort['completeCurrent']>(
    async () => 'entry',
  )
  const attach = vi.fn<RecordingAllurePort['attachRetainedVideos']>(
    async (paths) => ({ attachedPaths: [...paths] }),
  )
  const coordinator = new WorkerRecordingCoordinator({
    actions: {
      finalizeMedia: (passed, keep) =>
        harness.controller.finalizeMedia(passed, keep),
      finalizeMediaWithoutOutcome: () =>
        harness.controller.finalizeWithoutOutcome(),
      getAvailability: () => ({ available: true }),
      getRecordedPaths: () => harness.session.filePaths,
      isRecordingActive: () => harness.session.isRecordingActive,
      resetRecording: () => harness.controller.reset(),
      runSerialized: (task) => harness.controller.runSerialized(task),
      startRecording: (metadata, retry) =>
        harness.controller.startForMetadata(metadata, retry),
    },
    allure: { attachRetainedVideos: attach },
    getLogLevel: () => 'warn',
    log: vi.fn(),
    options: harness.resolved.options,
  })
  coordinator.configureSession({
    framework: 'mocha',
    specFileRetryAttempt: 0,
    manifest: {
      currentEntryId: 'entry',
      beginEntity: async () => 'entry',
      completeCurrent,
      recordResult: async () => {},
      recordSkippedEntity: async () => 'entry',
      setCurrentAttempt: () => {},
    },
  })
  const endFailedTest = () =>
    coordinator.endEntity({ manifestResult: 'failed', passed: false })
  return { attach, completeCurrent, coordinator, endFailedTest }
}

/** What a kept recording leaves: its result and the files under outputDir. */
const keepThreeTabs = async (
  service: WdioPuppeteerVideoServiceOptions,
  harnessOptions: Partial<HarnessOptions> = {},
) => {
  const harness = createHarness({ ...harnessOptions, service })
  await harness.recordThreeTabs()
  const finalized = await harness.controller.finalizeMedia(false, true)
  const tree = await listTree()
  await harness.controller.reset()
  return { finalized, harness, tree }
}

const baseNames = (paths: readonly string[]): string[] =>
  paths.map((filePath) => path.basename(filePath))

describe('kept deferred recordings', () => {
  it.each([
    ['WebM', {}],
    ['MP4 transcode', { processing: MP4 }],
    [
      'MP4 transcode and merge',
      { processing: { ...MP4, merge: { enabled: true } } },
    ],
    ['WebM merge', { processing: { merge: { enabled: true } } }],
  ] as const)(
    'produces the files, names, parts and tabs a live recording does: %s',
    async (_name, service) => {
      const live = await keepThreeTabs(service)
      await fs.rm(outputDir, { force: true, recursive: true })
      await fs.mkdir(outputDir)
      const deferred = await keepThreeTabs({
        ...service,
        capture: DEFERRED,
      })

      expect(baseNames(deferred.finalized.paths)).toEqual(
        baseNames(live.finalized.paths),
      )
      expect(deferred.finalized.tabs).toEqual(live.finalized.tabs)
      expect(deferred.finalized.captureFailure).toBeUndefined()
      expect(deferred.finalized.deferred).toBe(live.finalized.deferred)
      // Nothing is left in the spool directory but the directory itself.
      expect(deferred.tree).toEqual(live.tree)
      expect(deferred.harness.encodeFfmpeg.run).toHaveBeenCalledTimes(3)
      expect(live.harness.encodeFfmpeg.run).not.toHaveBeenCalled()
    },
  )

  it('encodes nothing while the test runs, then every spool before any transcode', async () => {
    const harness = createHarness({
      service: { capture: DEFERRED, processing: MP4 },
    })
    await harness.recordThreeTabs()
    expect(harness.encodeFfmpeg.run).not.toHaveBeenCalled()
    expect(harness.transcode).not.toHaveBeenCalled()

    await harness.controller.finalizeMedia(false, true)

    const encodeOrder = vi.mocked(harness.encodeFfmpeg.run).mock
      .invocationCallOrder
    const transcodeOrder = harness.transcode.mock.invocationCallOrder
    expect(encodeOrder).toHaveLength(3)
    expect(transcodeOrder).toHaveLength(3)
    expect(Math.max(...encodeOrder)).toBeLessThan(Math.min(...transcodeOrder))
  })

  it('never takes a processing slot while it holds a recording slot', async () => {
    const harness = createHarness({ service: { capture: DEFERRED } })
    await harness.recordThreeTabs()

    await harness.controller.finalizeMedia(false, true)

    expect(harness.leases).not.toContain('processing slot while recording')
    expect(harness.leases.slice(-4)).toEqual([
      'recording slot released',
      'processing slot',
      'processing slot',
      'processing slot',
    ])
  })

  it('keeps the frames of a spool that cannot be encoded and reports the recording incomplete', async () => {
    const harness = createHarness({
      service: {
        capture: DEFERRED,
        failurePolicy: 'error',
        processing: { ...MP4, merge: { enabled: true } },
      },
    })
    const reporting = createReportingCoordinator(harness)
    await harness.recordThreeTabs()
    harness.encodes.failParts.add(2)
    const framesPath = path.join(
      outputDir,
      `${harness.session.currentTestSlug}_part2.frames.mkv`,
    )

    const ended = reporting.endFailedTest()

    await expect(ended).rejects.toThrow(
      `Segment 2 (tab 2) could not be encoded: FFmpeg exited with code 1 while encoding the frame spool: Invalid data found when processing input. Its frames are kept at ${framesPath}`,
    )
    // One retry, then the frames are kept; nothing was merged.
    expect(harness.encodeFfmpeg.run).toHaveBeenCalledTimes(4)
    expect(harness.merge).not.toHaveBeenCalled()
    const entry = reporting.completeCurrent.mock.calls[0]?.[0]
    expect(entry).toMatchObject({
      decision: 'failed',
      processingOperation: 'capture',
      reason: 'capture-incomplete',
    })
    // The frames file is not a segment, a video or an attachment.
    expect(baseNames(entry?.paths ?? [])).toEqual([
      expect.stringMatching(/_part1\.mp4$/u),
      expect.stringMatching(/_part3\.mp4$/u),
    ])
    expect(entry?.tabs).toEqual(
      new Map([
        [1, { contextId: 'tab-a', ordinal: 1, reason: 'start' }],
        [3, { contextId: 'tab-a', ordinal: 1, reason: 'switch-to-window' }],
      ]),
    )
    const attached = reporting.attach.mock.calls[0]?.[0] ?? []
    expect(attached).toEqual(entry?.paths)
    expect(attached.some((file) => file.endsWith('.mkv'))).toBe(false)
    await expect(fs.readFile(framesPath, 'utf8')).resolves.toBe(
      'spooled-frames',
    )
    expect(
      (await listTree()).filter((file) => file.includes('.wdio-video-spool')),
    ).toEqual([])
    const warnings = harness.logs.filter(({ message }) =>
      message.includes(framesPath),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain(`ffmpeg -i "${framesPath}"`)
  })

  it('finalizes a live part between spooled ones in part order', async () => {
    const harness = createHarness({
      service: { capture: DEFERRED, processing: MP4 },
    })
    harness.engine.liveParts.add(2)
    await harness.recordThreeTabs()
    expect(
      harness.session.heldSegments.map((held) => held.spool !== undefined),
    ).toEqual([true, false])

    const finalized = await harness.controller.finalizeMedia(false, true)

    expect(baseNames(finalized.paths)).toEqual([
      expect.stringMatching(/_part1\.mp4$/u),
      expect.stringMatching(/_part2\.mp4$/u),
      expect.stringMatching(/_part3\.mp4$/u),
    ])
    expect(harness.encodeFfmpeg.run).toHaveBeenCalledTimes(2)
    expect(
      harness.finalizeSegment.mock.calls.map(([segment]) =>
        path.basename(segment.recordingPath),
      ),
    ).toEqual([
      expect.stringMatching(/_part1\.webm$/u),
      expect.stringMatching(/_part2\.webm$/u),
      expect.stringMatching(/_part3\.webm$/u),
    ])
  })

  it('keeps an unclean spool as unclean media and deletes its spool', async () => {
    const harness = createHarness({
      service: { capture: DEFERRED, processing: MP4 },
    })
    harness.engine.uncleanParts.add(1)
    await harness.recordThreeTabs()

    const finalized = await harness.controller.finalizeMedia(false, true)

    expect(baseNames(finalized.paths)).toEqual([
      expect.stringMatching(/_part1\.webm$/u),
      expect.stringMatching(/_part2\.mp4$/u),
      expect.stringMatching(/_part3\.mp4$/u),
    ])
    expect(finalized.captureFailure).toContain('did not finish cleanly')
    expect(harness.transcode).toHaveBeenCalledTimes(2)
    expect(await framesFiles()).toEqual([])
    expect(await spoolFiles()).toEqual([])
  })

  it('encodes a recording whose outcome is never known when the worker ends', async () => {
    const harness = createHarness({ service: { capture: DEFERRED } })
    await harness.recordThreeTabs()

    await harness.controller.finalizeWithoutOutcome()

    expect(harness.encodeFfmpeg.run).toHaveBeenCalledTimes(3)
    expect(baseNames(harness.session.recordedPaths)).toEqual([
      expect.stringMatching(/_part1\.webm$/u),
      expect.stringMatching(/_part2\.webm$/u),
      expect.stringMatching(/_part3\.webm$/u),
    ])
    expect(harness.session.heldSegments).toEqual([])
    expect(harness.leases).not.toContain('processing slot while recording')
  })

  it('lists the encoded parts of a recording a session reload interrupts', async () => {
    const harness = createHarness({ service: { capture: DEFERRED } })
    const reporting = createReportingCoordinator(harness)
    await harness.recordThreeTabs()

    await reporting.coordinator.finalizeInterruptedRecording()

    expect(harness.encodeFfmpeg.run).toHaveBeenCalledTimes(3)
    expect(reporting.attach).not.toHaveBeenCalled()
    const entry = reporting.completeCurrent.mock.calls[0]?.[0]
    expect(entry).toMatchObject({ decision: 'recorded', result: 'unknown' })
    expect(baseNames(entry?.paths ?? [])).toEqual([
      expect.stringMatching(/_part1\.webm$/u),
      expect.stringMatching(/_part2\.webm$/u),
      expect.stringMatching(/_part3\.webm$/u),
    ])
    expect(entry?.tabs?.size).toBe(3)
    expect(harness.session.isRecordingActive).toBe(false)
  })

  it('reports an interrupted recording whose spool cannot be encoded as incomplete', async () => {
    const harness = createHarness({ service: { capture: DEFERRED } })
    const reporting = createReportingCoordinator(harness)
    await harness.recordThreeTabs()
    harness.encodes.failParts.add(2)
    const framesPath = path.join(
      outputDir,
      `${harness.session.currentTestSlug}_part2.frames.mkv`,
    )

    await reporting.coordinator.finalizeInterruptedRecording()

    const entry = reporting.completeCurrent.mock.calls[0]?.[0]
    expect(entry).toMatchObject({
      decision: 'failed',
      reason: 'capture-incomplete',
      result: 'unknown',
    })
    expect(baseNames(entry?.paths ?? [])).toEqual([
      expect.stringMatching(/_part1\.webm$/u),
      expect.stringMatching(/_part3\.webm$/u),
    ])
    await expect(fs.readFile(framesPath, 'utf8')).resolves.toBe(
      'spooled-frames',
    )
  })
})

const framesFiles = async (): Promise<string[]> =>
  (await listTree()).filter((file) => file.endsWith('.frames.mkv'))

const spoolFiles = async (): Promise<string[]> =>
  (await listTree()).filter((file) => file.includes('.wdio-video-spool/'))

describe('resetting or ending a worker with spools', () => {
  it('turns held and attached spools into frames files, never encoding or deleting them', async () => {
    const harness = createHarness({ service: { capture: DEFERRED } })
    await harness.recordThreeTabs()
    const slug = harness.session.currentTestSlug

    // As when finalization failed before its encode step.
    await harness.controller.reset()

    expect(harness.encodeFfmpeg.run).not.toHaveBeenCalled()
    expect(await spoolFiles()).toEqual([])
    expect(await framesFiles()).toEqual([
      `${slug}_part1.frames.mkv`,
      `${slug}_part2.frames.mkv`,
      `${slug}_part3.frames.mkv`,
    ])
    for (const part of [1, 2, 3]) {
      const framesPath = path.join(
        outputDir,
        `${slug}_part${part.toString()}.frames.mkv`,
      )
      await expect(fs.readFile(framesPath, 'utf8')).resolves.toBe(
        'spooled-frames',
      )
      expect(harness.logs).toContainEqual({
        level: 'warn',
        message: expect.stringContaining(
          `Segment ${part.toString()} (tab ${part === 2 ? '2' : '1'}) was not encoded before its recording was reset. Its frames are kept at ${framesPath}`,
        ),
      })
    }
    expect(harness.session.heldSegments).toEqual([])
    expect(harness.leases).not.toContain('processing slot while recording')
  })

  it('leaves a spool it cannot move in place, names it, and lets it go', async () => {
    const linkFile = vi.fn(async () => {
      throw Object.assign(new Error('EXDEV: cross-device link'), {
        code: 'EXDEV',
      })
    })
    const harness = createHarness({
      encoder: { linkFile },
      service: { capture: DEFERRED },
    })
    await harness.recordThreeTabs()
    const spools = [harness.spoolOf(1), harness.spoolOf(2), harness.spoolOf(3)]

    await harness.controller.reset()

    for (const spool of spools) {
      await expect(fs.readFile(spool, 'utf8')).resolves.toBe('spooled-frames')
      expect(harness.logs).toContainEqual({
        level: 'warn',
        message: expect.stringContaining(
          `could not be moved (EXDEV: cross-device link) and stay at ${spool}`,
        ),
      })
    }
    expect(await framesFiles()).toEqual([])
    // Ownership is cleared once the warning names the path: nothing retries.
    expect(harness.session.heldSegments).toEqual([])
    await harness.controller.reset()
    expect(linkFile).toHaveBeenCalledTimes(3)
  })

  it('does not encode again on teardown after the encode step was cancelled at shutdown', async () => {
    const harness = createHarness({ service: { capture: DEFERRED } })
    await harness.recordThreeTabs()
    harness.encodes.run = async () => {
      harness.encodes.accepting = false
      return { kind: 'stopped', reason: 'cancelled' }
    }

    const finalized = await harness.controller.finalizeMedia(false, true)
    expect(finalized.captureFailure).toContain(
      'the encode was cancelled at shutdown',
    )
    const frames = await framesFiles()

    // Teardown: the worker resumes work, ends the recording and resets it.
    harness.encodes.accepting = true
    harness.encodes.run = undefined
    await harness.controller.finalizeWithoutOutcome()
    await harness.controller.reset()

    expect(harness.encodeFfmpeg.run).toHaveBeenCalledOnce()
    expect(await framesFiles()).toEqual(frames)
    expect(frames).toHaveLength(3)
    expect(await spoolFiles()).toEqual([])
  })

  it('does not encode again on teardown after the budget ran out', async () => {
    const time = createControlledClock()
    const harness = createHarness({
      encoder: {
        clock: time.clock,
        limits: {
          budgetMsPerCapturedSecond: 0,
          maximumBudgetMs: 50,
          maximumSlotWaitMs: 30_000,
          minimumBudgetMs: 50,
        },
      },
      service: { capture: DEFERRED },
    })
    await harness.recordThreeTabs()
    // An encoder that only stops when it is told to.
    harness.encodes.run = async (signal) => {
      await new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => {
          resolve()
        })
      })
      return { kind: 'stopped', reason: 'cancelled' }
    }

    const finishing = harness.controller.finalizeMedia(false, true)
    await vi.waitFor(() => {
      expect(harness.encodeFfmpeg.run).toHaveBeenCalledOnce()
    })
    time.advance(50)
    const finalized = await finishing
    expect(finalized.captureFailure).toContain(
      'the deferred-encode budget of 0.05s ran out',
    )
    harness.encodes.run = undefined
    await harness.controller.finalizeWithoutOutcome()
    await harness.controller.reset()

    expect(harness.encodeFfmpeg.run).toHaveBeenCalledOnce()
    expect(await framesFiles()).toHaveLength(3)
    expect(await spoolFiles()).toEqual([])
  })

  it('deletes no spool of a recording reset after it was discarded', async () => {
    const harness = createHarness({ service: { capture: DEFERRED } })
    await harness.recordThreeTabs()

    await harness.controller.finalizeMedia(true, false)
    await harness.controller.reset()

    expect(await listTree()).toEqual([])
    expect(harness.logs.filter(({ level }) => level === 'warn')).toEqual([])
  })
})
