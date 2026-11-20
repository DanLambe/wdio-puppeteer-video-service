import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Frameworks } from '@wdio/types'
import { afterEach, describe, expect, it } from 'vitest'
import WdioPuppeteerVideoLauncher from '../../src/launcher.js'
import type { VideoManifestV1 } from '../../src/manifest.js'
import type { WorkerCompositionOverrides } from '../../src/service/composition.js'
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

describe('a worker whose session reloads mid test', () => {
  it('lists the video it kept in the test entry the reporter joins', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reload-entry-'))
    tempDirs.push(outputDir)
    const config = { framework: 'mocha', logLevel: 'silent' }
    const capabilities = { browserName: 'chrome' }
    const specs = ['tests/reload.spec.ts']
    const options: WdioPuppeteerVideoServiceOptions = {
      outputDir,
      logLevel: 'silent',
      recording: { retain: 'failures' },
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
    const overrides = {
      connectPuppeteer: async () => puppeteer,
      startScreencast: async (
        _page: unknown,
        start: { readonly outputPath: string },
      ) => {
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
    const test = {
      title: 'reloads mid test',
      parent: 'suite',
      file: specs[0],
    } as Frameworks.Test

    await worker.beforeSession(config, capabilities, specs, '0-0')
    await worker.before(capabilities, specs, browser)
    await worker.beforeTest(test, undefined)
    await worker.onReload('session-before-reload', 'session-after-reload')
    await worker.afterTest(test, undefined, { passed: true } as never)
    await worker.after()
    await worker.afterSession()
    await launcher.onComplete(0)

    const videos = (await fs.readdir(outputDir)).filter((file) =>
      file.endsWith('.webm'),
    )
    expect(videos).toHaveLength(1)
    const manifest = JSON.parse(
      await fs.readFile(path.join(outputDir, 'manifest.json'), 'utf8'),
    ) as VideoManifestV1
    expect(
      manifest.runs[0]?.entries.map((entry) => ({
        test: entry.test?.name,
        result: entry.result,
        decision: entry.capture.decision,
        segments: entry.capture.segments.map((segment) => segment.path),
      })),
    ).toEqual([
      {
        test: 'reloads mid test',
        result: 'passed',
        decision: 'recorded',
        segments: videos,
      },
    ])
  })
})
