import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Frameworks } from '@wdio/types'
import { describe, expect, it, vi } from 'vitest'
import WdioPuppeteerVideoLauncher from '../../src/launcher.js'
import { nodeFileSystem } from '../../src/service/boundaries.js'
import { WorkerRecordingCoordinator } from '../../src/service/worker-recording-coordinator.js'
import WdioPuppeteerVideoService from '../../src/service.js'

const RETRY_RECORDING_SPEC_PATH = 'tests/advanced/specs/retry-recording.spec.ts'
const RETRY_RECORDING_SPECS = [RETRY_RECORDING_SPEC_PATH]

const createTest = (
  overrides: Partial<Frameworks.Test> = {},
): Frameworks.Test => ({
  type: 'test',
  title: 'default test',
  parent: 'suite',
  fullTitle: 'suite default test',
  pending: false,
  file: 'tests/specs/e2e.test.ts',
  fullName: 'suite default test',
  ctx: {},
  ...overrides,
})

const withTempDir = async (
  run: (tempDir: string) => Promise<void>,
): Promise<void> => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wdio-video-service-unit-'),
  )
  try {
    await run(tempDir)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

const createRetryLauncherService = (outputDir: string) =>
  new WdioPuppeteerVideoLauncher({
    outputDir,
    recording: { attempts: 'retries' },
  })

const primeRetryStateForSecondWorker = async (
  launcherService: WdioPuppeteerVideoLauncher,
  firstCapabilities: WebdriverIO.Capabilities,
  specs: string[],
  secondCapabilities = firstCapabilities,
): Promise<Record<string, unknown>> => {
  await launcherService.onPrepare()
  launcherService.onWorkerStart('0-0', firstCapabilities, specs, {})
  await launcherService.onWorkerEnd('0-0', 1, specs, 0)
  const workerConfig: Record<string, unknown> = { framework: 'mocha' }
  launcherService.onWorkerStart('0-0', secondCapabilities, specs, workerConfig)
  return workerConfig
}

const createRetryWorkerHarness = (
  outputDir: string,
): { workerService: WdioPuppeteerVideoService; seenRetryCounts: number[] } => {
  const seenRetryCounts: number[] = []
  const workerService = new WdioPuppeteerVideoService(
    {
      outputDir,
      recording: { attempts: 'retries' },
    },
    undefined,
    undefined,
    {
      createRecordingCoordinator: (options) =>
        new WorkerRecordingCoordinator({
          ...options,
          actions: {
            ...options.actions,
            getAvailability: () => ({ available: true }),
            startRecording: async (_metadata, retryCount) => {
              seenRetryCounts.push(retryCount)
              return true
            },
          },
        }),
    },
  )
  return { workerService, seenRetryCounts }
}

const runSpecFileRetryBeforeTest = async (
  workerService: WdioPuppeteerVideoService,
  workerConfig: Record<string, unknown>,
  workerCapabilities: WebdriverIO.Capabilities,
  specs: string[],
): Promise<void> => {
  const specPath = specs[0] ?? RETRY_RECORDING_SPEC_PATH
  await workerService.beforeSession(
    workerConfig,
    workerCapabilities,
    specs,
    '0-0',
  )
  await workerService.beforeTest(
    createTest({
      title: 'spec file retry candidate',
      file: specPath,
    }),
    {},
  )
}

describe('WdioPuppeteerVideoService worker adapter', () => {
  it('rejects removed flat configuration keys', () => {
    expect(
      () =>
        new WdioPuppeteerVideoService({
          outputFormat: 'avi',
        } as never),
    ).toThrow('processing.format')
  })

  it('does not probe FFmpeg during worker initialization', async () => {
    const runFfmpeg = vi.fn(async () => true)
    const service = new WdioPuppeteerVideoService({}, undefined, undefined, {
      runFfmpeg,
    })
    const browser = {
      sessionId: 'abc123',
      isMultiremote: false,
      capabilities: { browserName: 'chrome' },
    } as Parameters<WdioPuppeteerVideoService['before']>[2]

    await service.before({}, ['tests/specs/e2e.test.ts'], browser)

    expect(runFfmpeg).not.toHaveBeenCalled()
  })

  it('ignores window commands safely before worker initialization', async () => {
    const service = new WdioPuppeteerVideoService()

    await expect(service.beforeCommand('closeWindow')).resolves.toBeUndefined()
    await expect(service.afterCommand('switchWindow')).resolves.toBeUndefined()
  })

  it('warns and leaves the worker usable when output directory creation fails', async () => {
    const messages: string[] = []
    const service = new WdioPuppeteerVideoService(
      { outputDir: 'blocked-output', logLevel: 'warn' },
      undefined,
      undefined,
      {
        fileSystem: {
          ...nodeFileSystem,
          mkdir: vi.fn(async () => {
            throw new Error('directory blocked')
          }),
        },
        writeLog: (_activeLevel, _level, message) => {
          messages.push(message)
        },
      },
    )
    const browser = {
      sessionId: 'abc123',
      isMultiremote: false,
      capabilities: { browserName: 'chrome' },
    } as Parameters<WdioPuppeteerVideoService['before']>[2]

    await expect(
      service.before({}, ['tests/specs/e2e.test.ts'], browser),
    ).resolves.toBeUndefined()

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Failed to create output directory'),
        expect.stringContaining('Recording disabled for this worker'),
      ]),
    )
  })

  it('hydrates spec-file retry attempts across worker restarts', async () => {
    await withTempDir(async (tempDir) => {
      const launcherCapabilities = {
        browserName: 'chrome',
        platformName: 'Windows',
        'goog:chromeOptions': {
          prefs: {
            'download.default_directory': 'C:/tmp/downloads-attempt-1',
          },
        },
        'wdio:chromedriverOptions': { port: 9515 },
      } as unknown as WebdriverIO.Capabilities
      const workerCapabilities = {
        browserName: 'chrome',
        platformName: 'Windows',
        'goog:chromeOptions': {
          prefs: {
            'download.default_directory': 'C:/tmp/downloads-attempt-2',
          },
        },
        'wdio:chromedriverOptions': { port: 9516 },
      } as unknown as WebdriverIO.Capabilities
      const launcherService = createRetryLauncherService(tempDir)
      const workerConfig = await primeRetryStateForSecondWorker(
        launcherService,
        launcherCapabilities,
        RETRY_RECORDING_SPECS,
      )
      const { workerService, seenRetryCounts } =
        createRetryWorkerHarness(tempDir)

      await runSpecFileRetryBeforeTest(
        workerService,
        workerConfig,
        workerCapabilities,
        RETRY_RECORDING_SPECS,
      )

      expect(seenRetryCounts).toEqual([1])
      await launcherService.onComplete()
    })
  })

  it('does not hydrate retry state across different browsers', async () => {
    await withTempDir(async (tempDir) => {
      const specs = RETRY_RECORDING_SPECS
      const launcherCapabilities = {
        browserName: 'chrome',
      } as WebdriverIO.Capabilities
      const workerCapabilities = {
        browserName: 'firefox',
      } as WebdriverIO.Capabilities
      const launcherService = createRetryLauncherService(tempDir)
      const workerConfig = await primeRetryStateForSecondWorker(
        launcherService,
        launcherCapabilities,
        specs,
        workerCapabilities,
      )
      const { workerService, seenRetryCounts } =
        createRetryWorkerHarness(tempDir)

      await runSpecFileRetryBeforeTest(
        workerService,
        workerConfig,
        workerCapabilities,
        specs,
      )

      expect(seenRetryCounts).toEqual([])
      await launcherService.onComplete()
    })
  })
})
