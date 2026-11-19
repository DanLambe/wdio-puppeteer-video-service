import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CDPSession, Page } from 'puppeteer-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Browser } from 'webdriverio'
import { nodeFileSystem, systemClock } from '../../src/service/boundaries.js'
import { startScreencast } from '../../src/service/capture.js'
import { CaptureSession } from '../../src/service/capture-session.js'
import { DeferredEncoder } from '../../src/service/deferred-encode.js'
import type { ServiceLogger } from '../../src/service/logging.js'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import { PuppeteerCaptureEngine } from '../../src/service/puppeteer-capture-engine.js'
import { RecordingController } from '../../src/service/recording-controller.js'
import { RecordingMediaCoordinator } from '../../src/service/recording-media-coordinator.js'
import { recordScreencast } from '../../src/service/screencast-recorder.js'
import type { SpoolLimits } from '../../src/service/spool-budget.js'
import type { WdioPuppeteerVideoServiceOptions } from '../../src/types.js'
import type { SlugMetadata } from '../../src/video-name-utils.js'
import {
  createFakeFfmpegProcess,
  type FakeFfmpegProcess,
} from '../utils/fake-ffmpeg.js'
import { testSpoolUuid } from '../utils/spool-fixtures.js'

// The real engine, recorder and controller over a scripted page and fake
// FFmpeg processes, with a real temp directory: what the service does with a
// recording whose spool is promoted to a live encoder.

const METADATA: SlugMetadata = {
  fileToken: 'promoted_spec',
  hashInput: 'promoted|spools|0',
  retryToken: '',
  testNameToken: 'promoted segments',
}

let outputDir = ''

beforeEach(async () => {
  outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-promoted-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(outputDir, { force: true, recursive: true })
})

const settle = async (turns = 2): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

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

const LIMITS: SpoolLimits = {
  // Small enough that a few frames promote a segment.
  promoteBytes: 320,
  hardCapBytes: 1_000_000,
  promoteFreeBytes: 0,
  stopFreeBytes: 0,
  freeCheckIntervalBytes: 1_000_000,
}

interface StackOptions {
  readonly limits?: Partial<SpoolLimits>
  /** Encoders started for a promotion hold their input still. */
  readonly stalledPromotions?: boolean
  /** Encoders started for a promotion fail to start. */
  readonly failPromotions?: boolean
  readonly service?: WdioPuppeteerVideoServiceOptions
}

const createStack = (stackOptions: StackOptions = {}) => {
  const resolved = resolveServiceConfiguration(
    {
      capture: { encoding: 'deferred', framePriming: false },
      ...stackOptions.service,
      outputDir,
    },
    'linux',
  )
  const session = new CaptureSession()
  const logs: Array<{ level: Parameters<ServiceLogger>[0]; message: string }> =
    []
  const log: ServiceLogger = (level, message) => {
    logs.push({ level, message })
  }
  // Seconds of scripted time; the recorder's clock and Chrome's timestamps.
  let now = 0
  const cdpSessions: Array<
    CDPSession & { emitFrame(text: string): void; sent: string[] }
  > = []
  const createCdpSession = () => {
    const cdp = new EventEmitter() as unknown as CDPSession & {
      emitFrame(text: string): void
      sent: string[]
    }
    const sent: string[] = []
    Object.assign(cdp, {
      detach: vi.fn(async () => {}),
      emitFrame: (text: string) => {
        ;(cdp as unknown as EventEmitter).emit('Page.screencastFrame', {
          data: Buffer.from(text).toString('base64'),
          metadata: { timestamp: 1_000 + now },
          sessionId: sent.length + 1,
        })
      },
      send: vi.fn(async (method: string) => {
        sent.push(method)
        if (method === 'Page.startScreencast') {
          cdp.emitFrame('start')
        }
        return {}
      }),
      sent,
    })
    cdpSessions.push(cdp)
    return cdp
  }
  const page = {
    bringToFront: vi.fn(async () => {}),
    createCDPSession: vi.fn(async () => createCdpSession()),
    evaluate: vi.fn(
      async (callback: (...args: string[]) => unknown, ...args: string[]) =>
        args.length === 0
          ? { devicePixelRatio: 1, height: 720, width: 1280 }
          : callback(...args),
    ),
    isClosed: () => false,
    setViewport: vi.fn(async () => {}),
    viewport: vi.fn(() => null),
  } as unknown as Page
  const browser = {
    capabilities: { browserName: 'chrome' },
    execute: vi.fn(
      async (
        callback: (property: string, id: string) => void,
        property: string,
        id: string,
      ) => {
        callback(property, id)
      },
    ),
    getWindowHandle: vi.fn(async () => 'tab-a'),
    getWindowHandles: vi.fn(async () => ['tab-a']),
    options: { hostname: 'localhost' },
  }
  session.setBrowser(browser as unknown as Browser)
  // Encoders FFmpeg would run: one per live segment or promotion.
  const encoders: FakeFfmpegProcess[] = []
  let promotionsStarted = 0
  const holdClock = {
    ...systemClock,
    setInterval: () => ({ unref: () => {} }) as unknown as NodeJS.Timeout,
  }
  let uuidIndex = 0
  const engine = new PuppeteerCaptureEngine({
    capture: resolved.options.capture,
    clock: systemClock,
    connectPuppeteer: vi.fn(async () => ({
      connected: true,
      pages: vi.fn(async () => [page]),
    })) as never,
    fileSystem: nodeFileSystem,
    getSessionToken: () => 'token',
    log,
    onConnectionFailure: () => {},
    onProtocolChanged: () => {},
    session,
    startScreencast: (target, options) =>
      startScreencast(target, options, (recordedPage, recorderOptions) =>
        recordScreencast(recordedPage, recorderOptions, {
          clock: holdClock,
          monotonicNow: () => now * 1_000,
          spawnProcess: (_command, args) => {
            // A spooled segment spawns nothing until it is promoted.
            const promotion = 'spoolPath' in recorderOptions
            if (promotion) {
              promotionsStarted += 1
            }
            const process = createFakeFfmpegProcess(
              args,
              promotion && stackOptions.failPromotions
                ? { spawnError: new Error('spawn ffmpeg ENOENT') }
                : { outputOnEnd: 'encoded' },
            )
            if (promotion && stackOptions.stalledPromotions) {
              process.stall()
            }
            encoders.push(process)
            return process.child
          },
          terminateProcessTree: async (child) => {
            child.kill()
          },
        }),
      ),
    uuid: () => {
      uuidIndex += 1
      return `uuid-${uuidIndex.toString()}`
    },
  })
  const ffmpegRuntime = {
    ensureReady: vi.fn(async () => true),
    resolvePath: vi.fn(() => 'ffmpeg'),
    shouldTranscode: vi.fn(() => false),
  }
  const media = new RecordingMediaCoordinator({
    captureSession: session,
    ffmpegRuntime,
    fileSystem: nodeFileSystem,
    getManifestRecorder: () => undefined,
    log,
    mediaPipeline: {
      merge: vi.fn(async () => undefined),
      reportFailure: vi.fn(),
      transcode: vi.fn(async () => undefined),
    } as never,
    options: resolved.options,
  })
  // How many slots were taken, and when a processing slot was.
  const slots = { processing: 0, recording: 0 }
  let recordingSlotOwned = false
  const encoder = new DeferredEncoder({
    clock: systemClock,
    concurrency: resolved.options.concurrency,
    ffmpeg: {
      isAcceptingWork: true,
      resolvePath: () => 'ffmpeg',
      run: vi.fn(async (args: string[], _operation: string, overrides = {}) => {
        await fs.writeFile(args.at(-1) ?? '', 'vp9')
        overrides.onResult?.({
          code: 0,
          diagnostic: '',
          kind: 'exited',
          signal: null,
        })
        return true
      }),
      withPostProcessSlot: vi.fn(async (_operation, task) => {
        slots.processing += 1
        return task()
      }),
    } as never,
    fileSystem: nodeFileSystem,
    log,
  })
  const controller = new RecordingController({
    captureEngine: engine,
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
        slots.recording += 1
        return true
      }),
      ownsGlobalRecordingSlot: false,
      get ownsRecordingSlot() {
        return recordingSlotOwned
      },
      release: vi.fn(async () => {
        recordingSlotOwned = false
      }),
    },
    spoolStorage: {
      diskSpace: { freeBytes: async () => Number.MAX_SAFE_INTEGER },
      directory: path.join(outputDir, '.wdio-video-spool', 'run-1'),
      encoder,
      limits: { ...LIMITS, ...stackOptions.limits },
      uuid: () => {
        uuidIndex += 1
        return testSpoolUuid(uuidIndex)
      },
    },
  })
  const current = () => cdpSessions.at(-1)
  let startedSlug = ''
  return {
    /** Frames for the current tab, a tenth of a second apart. */
    frames: async (count: number): Promise<void> => {
      for (let index = 0; index < count; index += 1) {
        now += 0.1
        current()?.emitFrame(`f${now.toFixed(1)}`)
        await settle()
      }
    },
    controller,
    encoders,
    logs,
    outputDir: () => outputDir,
    promotionsStarted: () => promotionsStarted,
    session,
    /** Frames until the current segment has been promoted. */
    promoted: async (): Promise<void> => {
      await vi.waitFor(() => {
        expect(session.recorder?.output.kind).toBe('encoded')
      })
    },
    slots,
    slug: () => startedSlug,
    start: async (): Promise<void> => {
      await controller.startForMetadata(METADATA, 0)
      startedSlug = session.currentTestSlug
    },
    tick: (seconds: number): void => {
      now += seconds
    },
  }
}

type Stack = ReturnType<typeof createStack>

const warnings = (stack: Stack): string[] =>
  stack.logs
    .filter((entry) => entry.level === 'warn')
    .map((entry) => entry.message)

const slug = (stack: Stack): string => stack.slug()

describe('a promoted recording in the service', () => {
  it('keeps a promoted segment as a live segment at its reserved path', async () => {
    const stack = createStack()
    await stack.start()
    await stack.frames(8)
    await stack.promoted()
    await stack.frames(4)

    const { paths } = await stack.controller.finalizeMedia(true, true)
    await stack.controller.reset()

    expect(paths).toEqual([path.join(outputDir, `${slug(stack)}_part1.webm`)])
    expect(await fs.readFile(paths[0] ?? '', 'utf8')).toBe('encoded')
    // No spool, no frames file, nothing else.
    expect(await listTree()).toEqual([`${slug(stack)}_part1.webm`])
    expect(warnings(stack)).toEqual([])
    expect(stack.encoders).toHaveLength(1)
  })

  it('leaves no file when a recording that promoted is discarded', async () => {
    const stack = createStack()
    await stack.start()
    await stack.frames(8)
    await stack.promoted()
    await stack.frames(4)

    const result = await stack.controller.finalizeMedia(true, false)
    await stack.controller.reset()

    expect(result.paths).toEqual([])
    expect(stack.encoders[0]?.kill).toHaveBeenCalled()
    expect(await listTree()).toEqual([])
    expect(stack.slots.processing).toBe(0)
  })

  it('starts the later segments live once a segment has promoted', async () => {
    const stack = createStack()
    await stack.start()
    await stack.frames(8)
    await stack.promoted()
    await stack.controller.followContext('tab-b', 'command')
    await stack.frames(3)
    await stack.controller.followContext('tab-a', 'switch-to-window')
    await stack.frames(3)

    const { paths } = await stack.controller.finalizeMedia(true, true)
    await stack.controller.reset()

    const base = path.join(outputDir, slug(stack))
    expect(paths).toEqual([
      `${base}_part1.webm`,
      `${base}_part2.webm`,
      `${base}_part3.webm`,
    ])
    // One encoder for the promotion and one for each later live segment, and
    // not a single spool encode: nothing was left spooled.
    expect(stack.encoders).toHaveLength(3)
    expect(stack.promotionsStarted()).toBe(1)
    expect(stack.slots.processing).toBe(0)
    expect(await listTree()).toEqual(
      ['_part1', '_part2', '_part3'].map(
        (part) => `${slug(stack)}${part}.webm`,
      ),
    )
  })

  it('mixes a spooled segment, a promoted one and a live one in part order', async () => {
    // Part 1 spools and stays under the threshold; part 2 spools on top of it
    // and promotes at the recording's total; part 3 starts live.
    const stack = createStack({ limits: { promoteBytes: 520 } })
    await stack.start()
    await stack.frames(2)
    await stack.controller.followContext('tab-b', 'command')
    await stack.frames(8)
    await stack.promoted()
    await stack.controller.followContext('tab-a', 'switch-to-window')
    await stack.frames(3)

    const { paths } = await stack.controller.finalizeMedia(true, true)
    await stack.controller.reset()

    const base = path.join(outputDir, slug(stack))
    expect(paths).toEqual([
      `${base}_part1.webm`,
      `${base}_part2.webm`,
      `${base}_part3.webm`,
    ])
    // Only the segment still spooled was encoded after the test.
    expect(stack.slots.processing).toBe(1)
    expect(await fs.readFile(`${base}_part1.webm`, 'utf8')).toBe('vp9')
    expect(await fs.readFile(`${base}_part2.webm`, 'utf8')).toBe('encoded')
    expect(await fs.readFile(`${base}_part3.webm`, 'utf8')).toBe('encoded')
    expect(await listTree()).toEqual(
      ['_part1', '_part2', '_part3'].map(
        (part) => `${slug(stack)}${part}.webm`,
      ),
    )
  })

  it('acquires no recording or processing slot when it promotes', async () => {
    const stack = createStack()
    await stack.start()
    await stack.frames(8)
    await stack.promoted()
    await stack.frames(4)
    expect(stack.slots).toEqual({ processing: 0, recording: 1 })

    await stack.controller.finalizeMedia(true, true)
    await stack.controller.reset()

    // One recording slot for the one segment, none for its promotion, and no
    // processing slot: nothing was left to encode.
    expect(stack.slots).toEqual({ processing: 0, recording: 1 })
  })
})

describe('a segment stopped during its replay in the service', () => {
  it('holds it as a spool, encodes it when kept, and leaves nothing of the promotion', async () => {
    const stack = createStack({ stalledPromotions: true })
    await stack.start()
    await stack.frames(8)
    await vi.waitFor(() => {
      expect(stack.encoders).toHaveLength(1)
    })
    expect(stack.session.recorder?.output.kind).toBe('spool')

    await stack.controller.followContext('tab-b', 'command')

    const [held] = stack.session.heldSegments
    expect(held?.spool).toBeDefined()
    expect(held?.clean).toBe(true)
    expect(stack.encoders[0]?.kill).toHaveBeenCalled()
    // The cancelled promotion's output is gone; only the next, live part exists.
    expect(await listTree()).not.toContain(`${slug(stack)}_part1.webm`)

    await stack.frames(2)
    const { paths } = await stack.controller.finalizeMedia(true, true)
    await stack.controller.reset()

    // The spooled part was encoded by the end-of-recording step.
    expect(await fs.readFile(paths[0] ?? '', 'utf8')).toBe('vp9')
    expect(stack.slots.processing).toBe(1)
    expect(await listTree()).toEqual(
      paths.map((file) => path.basename(file)).sort(),
    )
  })

  it('deletes the spool of a recording discarded after the replay was cancelled', async () => {
    const stack = createStack({ stalledPromotions: true })
    await stack.start()
    await stack.frames(8)
    await vi.waitFor(() => {
      expect(stack.encoders).toHaveLength(1)
    })
    await stack.controller.followContext('tab-b', 'command')
    await stack.frames(2)

    await stack.controller.finalizeMedia(true, false)
    await stack.controller.reset()

    expect(await listTree()).toEqual([])
    expect(stack.slots.processing).toBe(0)
  })
})

describe('a segment whose encoder cannot take over in the service', () => {
  it('keeps spooling, warns once, and encodes the spool when kept', async () => {
    const stack = createStack({ failPromotions: true })
    await stack.start()
    await stack.frames(8)
    await vi.waitFor(() => {
      expect(warnings(stack)).toHaveLength(1)
    })
    await stack.frames(6)

    expect(stack.session.recorder?.output.kind).toBe('spool')
    const { paths } = await stack.controller.finalizeMedia(true, true)
    await stack.controller.reset()

    // One attempt, one warning, one encode of the spool afterwards.
    expect(stack.promotionsStarted()).toBe(1)
    expect(warnings(stack)).toHaveLength(1)
    expect(warnings(stack)[0]).toContain('keep going to the frame spool')
    expect(await fs.readFile(paths[0] ?? '', 'utf8')).toBe('vp9')
    expect(stack.slots.processing).toBe(1)
    expect(await listTree()).toEqual([`${slug(stack)}_part1.webm`])
  })

  it('still starts the later segments live, since the recording used its allowance', async () => {
    const stack = createStack({ failPromotions: true })
    await stack.start()
    await stack.frames(8)
    await vi.waitFor(() => {
      expect(warnings(stack)).toHaveLength(1)
    })
    await stack.controller.followContext('tab-b', 'command')
    await stack.frames(3)

    expect(stack.session.recorder?.output.kind).toBe('encoded')
    await stack.controller.finalizeMedia(true, true)
    await stack.controller.reset()
  })
})
