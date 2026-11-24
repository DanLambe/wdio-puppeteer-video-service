import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Frameworks } from '@wdio/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WdioPuppeteerVideoLauncher from '../../src/launcher.js'
import type { VideoManifestV1 } from '../../src/manifest.js'
import type { WorkerCompositionOverrides } from '../../src/service/composition.js'
import { FfmpegRuntime } from '../../src/service/ffmpeg-runtime.js'
import { parseManifestJournals } from '../../src/service/manifest-journal.js'
import {
  createManifestRunContext,
  ManifestWorkerRecorder,
} from '../../src/service/manifest-runtime.js'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import { normalizeTestEntity } from '../../src/service/recording-entity.js'
import {
  type RecordingMediaFinalization,
  WorkerRecordingCoordinator,
} from '../../src/service/worker-recording-coordinator.js'
import { WdioPuppeteerVideoWorkerRuntime } from '../../src/service/worker-runtime.js'
import type { WdioPuppeteerVideoServiceOptions } from '../../src/types.js'

// A completion hook (`afterTest`, `afterScenario`) that a framework times out
// keeps running while the next entity starts, and a session reload or the
// worker's end can stop a recording before its entity's result arrives. Each
// entity's manifest entry must still describe that entity's own media.

const tempDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  )
})

const entity = (title: string, tags: string[] = []) =>
  normalizeTestEntity(
    {
      title,
      fullTitle: `suite ${title}`,
      file: 'tests/spec.ts',
    } as Frameworks.Test,
    { tags },
    'mocha',
    'test',
  )

interface EntrySummary {
  readonly decision: string
  readonly reason?: string
  readonly result: string
  readonly segments: readonly string[]
}

const createHarness = async (
  serviceOptions: WdioPuppeteerVideoServiceOptions = {},
) => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-entity-'))
  tempDirs.push(outputDir)
  const context = await createManifestRunContext(outputDir, 'run-entity')
  const manifest = new ManifestWorkerRecorder({
    context,
    cid: '0-0',
    framework: 'mocha',
  })
  manifest.configureSession({
    sessionId: 'session',
    browserName: 'chrome',
    protocol: 'bidi+cdp',
  })

  // The recording controller's queue: tasks run one at a time, in call order.
  let queue: Promise<void> = Promise.resolve()
  const runSerialized = (task: () => Promise<void>): Promise<void> => {
    const next = queue.then(task, task)
    queue = next.catch(() => undefined)
    return next
  }
  const gates = new Map<
    string,
    {
      entered: PromiseWithResolvers<void>
      release: PromiseWithResolvers<void>
    }
  >()
  let recording: string | undefined
  const videoOf = (token: string): string =>
    path.join(outputDir, `${token}_part1.webm`)
  const takeRecording = async (
    keepArtifacts: boolean,
  ): Promise<RecordingMediaFinalization> => {
    const token = recording
    if (token === undefined) {
      return { deferred: false, paths: [] }
    }
    const gate = gates.get(token)
    if (gate) {
      gate.entered.resolve()
      await gate.release.promise
    }
    recording = undefined
    if (!keepArtifacts) {
      await fs.rm(videoOf(token), { force: true })
      return { deferred: false, paths: [] }
    }
    return { deferred: false, paths: [videoOf(token)] }
  }

  const coordinator = new WorkerRecordingCoordinator({
    options: resolveServiceConfiguration({
      outputDir,
      ...serviceOptions,
    }).options,
    getLogLevel: () => 'silent',
    log: () => undefined,
    actions: {
      getAvailability: () => ({ available: true }),
      isRecordingActive: () => recording !== undefined,
      getRecordedPaths: () => (recording ? [videoOf(recording)] : []),
      runSerialized,
      async startRecording(metadata) {
        recording = metadata.testNameToken
        await fs.writeFile(videoOf(recording), 'video')
        return true
      },
      finalizeMedia: (_passed, keepArtifacts) => takeRecording(keepArtifacts),
      finalizeMediaWithoutOutcome: () => takeRecording(true),
      async resetRecording() {
        recording = undefined
      },
    },
  })
  coordinator.configureSession({
    framework: 'mocha',
    manifest,
    specFileRetryAttempt: 0,
  })
  coordinator.beginWorker(['tests/spec.ts'])

  return {
    coordinator,
    /** Pauses the given recording's finalization until it is released. */
    holdFinalization(token: string) {
      const gate = {
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      }
      gates.set(token, gate)
      return {
        entered: gate.entered.promise,
        release: () => {
          gate.release.resolve()
        },
      }
    },
    async entries(): Promise<Record<string, EntrySummary>> {
      const parsed = await parseManifestJournals(context)
      expect(parsed.diagnostics).toEqual([])
      return Object.fromEntries(
        parsed.entries.map((entry) => [
          entry.test?.name ?? entry.scope,
          {
            decision: entry.capture.decision,
            ...(entry.capture.reason ? { reason: entry.capture.reason } : {}),
            result: entry.result,
            segments: entry.capture.segments.map((segment) =>
              path.basename(segment.path),
            ),
          },
        ]),
      )
    },
  }
}

/** Lets every queued step that is not waiting on a gate run. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
  }
}

describe('manifest entries of overlapping entities', () => {
  it('keeps a timed-out failed test and the passing test after it apart', async () => {
    const harness = await createHarness({ recording: { retain: 'failures' } })
    await harness.coordinator.beginEntity(entity('test-1'))
    const finalizing = harness.holdFinalization('test_1')

    const ended = harness.coordinator.endEntity({
      passed: false,
      manifestResult: 'failed',
    })
    await finalizing.entered
    // The framework timed the hook out and starts the next test.
    const begun = harness.coordinator.beginEntity(entity('test-2'))
    await settle()
    finalizing.release()
    await Promise.all([ended, begun])
    await harness.coordinator.endEntity({
      passed: true,
      manifestResult: 'passed',
    })

    expect(await harness.entries()).toEqual({
      'test-1': {
        decision: 'recorded',
        result: 'failed',
        segments: ['test_1_part1.webm'],
      },
      'test-2': {
        decision: 'discarded',
        reason: 'retention-policy',
        result: 'passed',
        segments: [],
      },
    })
  })

  it('keeps a filtered test that starts during a timed-out finalization apart', async () => {
    const harness = await createHarness({
      recording: {
        retain: 'failures',
        filters: { excludeTags: ['@no-video'] },
      },
    })
    await harness.coordinator.beginEntity(entity('test-1'))
    const finalizing = harness.holdFinalization('test_1')

    const ended = harness.coordinator.endEntity({
      passed: false,
      manifestResult: 'failed',
    })
    await finalizing.entered
    const begun = harness.coordinator.beginEntity(
      entity('test-2', ['@no-video']),
    )
    const secondEnded = harness.coordinator.endEntity({
      passed: true,
      manifestResult: 'passed',
    })
    await settle()
    finalizing.release()
    await Promise.all([ended, begun, secondEnded])

    expect(await harness.entries()).toEqual({
      'test-1': {
        decision: 'recorded',
        result: 'failed',
        segments: ['test_1_part1.webm'],
      },
      'test-2': {
        decision: 'skipped',
        reason: 'filtered',
        result: 'passed',
        segments: [],
      },
    })
  })

  it('gives a failing test that also overlaps its own video', async () => {
    const harness = await createHarness({ recording: { retain: 'failures' } })
    await harness.coordinator.beginEntity(entity('test-1'))
    const finalizing = harness.holdFinalization('test_1')

    const ended = harness.coordinator.endEntity({
      passed: false,
      manifestResult: 'failed',
    })
    await finalizing.entered
    // Waiting on the first test's encode, the second test's own hooks can
    // time out too, so its result can arrive before its recording starts.
    const begun = harness.coordinator.beginEntity(entity('test-2'))
    const secondEnded = harness.coordinator.endEntity({
      passed: false,
      manifestResult: 'failed',
    })
    await settle()
    finalizing.release()
    await Promise.all([ended, begun, secondEnded])

    expect(await harness.entries()).toEqual({
      'test-1': {
        decision: 'recorded',
        result: 'failed',
        segments: ['test_1_part1.webm'],
      },
      'test-2': {
        decision: 'recorded',
        result: 'failed',
        segments: ['test_2_part1.webm'],
      },
    })
  })

  it('accumulates overlapping results on one spec entry', async () => {
    const harness = await createHarness({
      recording: { retain: 'failures', scope: 'spec' },
    })
    await harness.coordinator.beginEntity(entity('test-1'))
    const ended = harness.coordinator.endEntity({
      passed: false,
      manifestResult: 'failed',
    })
    const begun = harness.coordinator.beginEntity(entity('test-2'))
    const secondEnded = harness.coordinator.endEntity({
      passed: true,
      manifestResult: 'passed',
    })
    await Promise.all([ended, begun, secondEnded])
    await harness.coordinator.finalizeSpecRecording()

    const entries = await harness.entries()
    expect(Object.values(entries)).toEqual([
      {
        decision: 'recorded',
        result: 'failed',
        segments: [expect.stringMatching(/_part1\.webm$/u)],
      },
    ])
  })
})

describe('manifest entries of recordings stopped before their result', () => {
  it.each([
    { passed: true, result: 'passed' },
    { passed: false, result: 'failed' },
  ] as const)(
    'records the kept media of a session reload, then the $result result',
    async ({ passed, result }) => {
      const harness = await createHarness({
        recording: { retain: 'failures' },
      })
      await harness.coordinator.beginEntity(entity('reloads mid test'))

      // `browser.reloadSession()` inside the test.
      await harness.coordinator.finalizeInterruptedRecording()
      await harness.coordinator.endEntity({
        passed,
        manifestResult: result,
      })

      expect(await harness.entries()).toEqual({
        'reloads mid test': {
          decision: 'recorded',
          result,
          segments: ['reloads_mid_test_part1.webm'],
        },
      })
    },
  )

  it('records the kept media of a worker that ends mid test', async () => {
    const harness = await createHarness()
    await harness.coordinator.beginEntity(entity('aborted test'))

    await harness.coordinator.finalizeInterruptedRecording()

    expect(await harness.entries()).toEqual({
      'aborted test': {
        decision: 'recorded',
        result: 'unknown',
        segments: ['aborted_test_part1.webm'],
      },
    })
  })

  it('leaves a later entity untouched by an earlier interrupted one', async () => {
    const harness = await createHarness({ recording: { retain: 'all' } })
    await harness.coordinator.beginEntity(entity('test-1'))
    await harness.coordinator.finalizeInterruptedRecording()
    await harness.coordinator.endEntity({
      passed: true,
      manifestResult: 'passed',
    })
    await harness.coordinator.beginEntity(entity('test-2'))
    await harness.coordinator.endEntity({
      passed: false,
      manifestResult: 'failed',
    })

    expect(await harness.entries()).toEqual({
      'test-1': {
        decision: 'recorded',
        result: 'passed',
        segments: ['test_1_part1.webm'],
      },
      'test-2': {
        decision: 'recorded',
        result: 'failed',
        segments: ['test_2_part1.webm'],
      },
    })
  })
})

/** A worker over fake Puppeteer and screencast, with a launcher for its run. */
const createReloadingWorker = async (
  framework: 'cucumber' | 'mocha',
  service: WdioPuppeteerVideoServiceOptions,
) => {
  // The screencast is fake, so no FFmpeg runs, and CI's unit job has none to
  // find: recording must not wait on looking for it.
  vi.spyOn(FfmpegRuntime.prototype, 'ensureReady').mockResolvedValue(true)
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reload-entry-'))
  tempDirs.push(outputDir)
  const config = { framework, logLevel: 'silent' }
  const capabilities = { browserName: 'chrome' }
  const specs =
    framework === 'cucumber'
      ? ['features/reload.feature']
      : ['tests/reload.spec.ts']
  const options: WdioPuppeteerVideoServiceOptions = {
    ...service,
    outputDir,
    logLevel: 'silent',
    capture: { encoding: 'live', framePriming: false },
  }
  const launcher = new WdioPuppeteerVideoLauncher(options, undefined, config)
  await launcher.onPrepare()
  launcher.onWorkerStart('0-0', capabilities, specs, config)

  const markers = new Map<string, unknown>()
  const page = {
    isClosed: () => false,
    url: () => 'http://example.test/',
    bringToFront: async () => {},
    on() {},
    off() {},
    target: () => ({ _targetId: 'ctx-1' }),
    evaluate: async (_script: unknown, marker: string) => markers.get(marker),
    createCDPSession: async () => ({
      send: async () => ({ targetInfo: { targetId: 'ctx-1' } }),
      detach: async () => {},
    }),
  }
  const puppeteer = {
    connected: true,
    on() {},
    off() {},
    once() {},
    pages: async () => [page],
    targets: () => [
      { type: () => 'page', _targetId: 'ctx-1', page: async () => page },
    ],
  }
  const starts: string[] = []
  const overrides = {
    connectPuppeteer: async () => puppeteer,
    startScreencast: async (
      _page: unknown,
      start: { readonly outputPath: string },
    ) => {
      starts.push(path.basename(start.outputPath))
      await fs.writeFile(start.outputPath, 'video')
      // The recorder members the capture engine reads.
      return {
        frameCount: 2,
        ffmpegResult: { code: 0, signal: null },
        incompleteReason: undefined,
        output: { kind: 'encoder', outputPath: start.outputPath },
        queueStats: {
          highWaterBlocks: 0,
          highWaterBytes: 0,
          highWaterLagSeconds: 0,
          pendingBlocks: 0,
          pendingBytes: 0,
        },
        async stop() {},
        async abort() {},
      }
    },
  } as unknown as WorkerCompositionOverrides
  const worker = new WdioPuppeteerVideoWorkerRuntime(
    options,
    capabilities,
    config,
    overrides,
  )
  const browser = {
    sessionId: 'session-before-reload',
    capabilities: { browserName: 'chrome', browserVersion: '150.0' },
    isBidi: false,
    options: { logLevel: 'silent' },
    getPuppeteer: async () => puppeteer,
    getWindowHandle: async () => 'ctx-1',
    getWindowHandles: async () => ['ctx-1'],
    execute: async (_script: unknown, marker: string, value: unknown) => {
      markers.set(marker, value)
    },
  } as unknown as Parameters<WdioPuppeteerVideoWorkerRuntime['before']>[2]
  await worker.beforeSession(config, capabilities, specs, '0-0')
  await worker.before(capabilities, specs, browser)

  return {
    specFile: specs[0] ?? '',
    starts,
    worker,
    reload: () =>
      worker.onReload('session-before-reload', 'session-after-reload'),
    /** Ends the worker and the run, then reads what it left. */
    async finish() {
      await worker.after()
      await worker.afterSession()
      await launcher.onComplete(0)
      const videos = (await fs.readdir(outputDir)).filter((file) =>
        file.endsWith('.webm'),
      )
      const manifest = JSON.parse(
        await fs.readFile(path.join(outputDir, 'manifest.json'), 'utf8'),
      ) as VideoManifestV1
      const entries = (manifest.runs[0]?.entries ?? [])
        .toSorted((left, right) =>
          left.timings.startedAt.localeCompare(right.timings.startedAt),
        )
        .map((entry) => ({
          name: entry.test?.name ?? entry.scope,
          attempt: entry.attempt,
          result: entry.result,
          decision: entry.capture.decision,
          segments: entry.capture.segments.map((segment) => segment.path),
        }))
      return { entries, videos }
    },
  }
}

const mochaTest = (title: string, file: string): Frameworks.Test =>
  ({ title, parent: 'suite', file }) as Frameworks.Test

describe('a worker whose session reloads mid test', () => {
  it('lists the video it kept in the test entry the reporter joins', async () => {
    const run = await createReloadingWorker('mocha', {
      recording: { retain: 'failures' },
    })
    const test = mochaTest('reloads mid test', run.specFile)

    await run.worker.beforeTest(test, undefined)
    await run.reload()
    await run.worker.afterTest(test, undefined, { passed: true } as never)
    const { entries, videos } = await run.finish()

    expect(videos).toHaveLength(1)
    expect(entries).toEqual([
      {
        name: 'reloads mid test',
        attempt: 1,
        result: 'passed',
        decision: 'recorded',
        segments: videos,
      },
    ])
  })

  // The spec's outcome is not known at a reload, so its recording so far is
  // kept, as a test-scoped one is; it never waits on retention there.
  it('keeps a spec recording that a reload interrupts, with the failure that follows', async () => {
    const run = await createReloadingWorker('mocha', {
      recording: { scope: 'spec', retain: 'failures' },
    })
    const test = mochaTest('fails after a reload', run.specFile)

    await run.worker.beforeTest(test, undefined)
    await run.reload()
    await run.worker.afterTest(test, undefined, { passed: false } as never)
    const { entries, videos } = await run.finish()

    expect(videos).toHaveLength(1)
    expect(entries).toEqual([
      {
        name: 'spec',
        attempt: 1,
        result: 'failed',
        decision: 'recorded',
        segments: videos,
      },
    ])
  })

  it('judges the spec recording after a reload by its own tests only', async () => {
    const run = await createReloadingWorker('mocha', {
      recording: { scope: 'spec', retain: 'failures' },
    })
    const reloading = mochaTest('fails after a reload', run.specFile)
    const next = mochaTest('passes on the new session', run.specFile)

    await run.worker.beforeTest(reloading, undefined)
    await run.reload()
    await run.worker.afterTest(reloading, undefined, { passed: false } as never)
    await run.worker.beforeTest(next, undefined)
    await run.worker.afterTest(next, undefined, { passed: true } as never)
    const { entries, videos } = await run.finish()

    // The first recording is kept for the failure; the second, whose only
    // test passed, is discarded.
    expect(run.starts).toHaveLength(2)
    expect(videos).toHaveLength(1)
    expect(entries).toEqual([
      {
        name: 'spec',
        attempt: 1,
        result: 'failed',
        decision: 'recorded',
        segments: videos,
      },
      expect.objectContaining({
        name: 'spec',
        result: 'passed',
        decision: 'discarded',
        segments: [],
      }),
    ])
  })

  it('does not carry a failure from before a reload into the next spec recording', async () => {
    const run = await createReloadingWorker('mocha', {
      recording: { scope: 'spec', retain: 'failures' },
    })
    const failing = mochaTest('fails before the reload', run.specFile)
    const reloading = mochaTest('reloads and passes', run.specFile)
    const next = mochaTest('passes on the new session', run.specFile)

    await run.worker.beforeTest(failing, undefined)
    await run.worker.afterTest(failing, undefined, { passed: false } as never)
    await run.worker.beforeTest(reloading, undefined)
    await run.reload()
    await run.worker.afterTest(reloading, undefined, { passed: true } as never)
    await run.worker.beforeTest(next, undefined)
    await run.worker.afterTest(next, undefined, { passed: true } as never)
    const { entries, videos } = await run.finish()

    expect(videos).toHaveLength(1)
    expect(entries).toEqual([
      {
        name: 'spec',
        attempt: 1,
        result: 'failed',
        decision: 'recorded',
        segments: videos,
      },
      expect.objectContaining({
        result: 'passed',
        decision: 'discarded',
        segments: [],
      }),
    ])
  })

  // Cucumber gives no attempt number: a retry is the scenario's next run in
  // the worker, so a reload must not forget the runs before it.
  it('still recognizes a Cucumber retry after a reload', async () => {
    const run = await createReloadingWorker('cucumber', {
      recording: { attempts: 'retries', retain: 'retries' },
    })
    const world = {
      pickle: {
        id: 'pickle-1',
        name: 'flaky reload scenario',
        uri: run.specFile,
      },
    } as unknown as Frameworks.World

    await run.worker.beforeScenario(world, {})
    await run.reload()
    await run.worker.afterScenario(world, { passed: false } as never)
    await run.worker.beforeScenario(world, {})
    await run.worker.afterScenario(world, { passed: true } as never)
    const { entries, videos } = await run.finish()

    expect(run.starts).toHaveLength(1)
    expect(videos).toHaveLength(1)
    expect(entries).toEqual([
      expect.objectContaining({ attempt: 1, decision: 'skipped' }),
      {
        name: 'flaky reload scenario',
        attempt: 2,
        result: 'passed',
        decision: 'recorded',
        segments: videos,
      },
    ])
  })
})
