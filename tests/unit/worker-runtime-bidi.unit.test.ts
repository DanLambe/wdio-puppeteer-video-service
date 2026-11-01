import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nodeFileSystem } from '../../src/service/boundaries.js'
import { ContextFollower } from '../../src/service/context-follower.js'
import { runInternal } from '../../src/service/internal-operation.js'
import { assignLauncherWorkerContext } from '../../src/service/launcher-context.js'
import {
  assignManifestRunContext,
  assignManifestWorkerContext,
} from '../../src/service/manifest-runtime.js'
import { PuppeteerCaptureEngine } from '../../src/service/puppeteer-capture-engine.js'
import { RecordingController } from '../../src/service/recording-controller.js'
import type { WorkerRecordingCoordinatorPort } from '../../src/service/worker-recording-coordinator.js'
import { WdioPuppeteerVideoWorkerRuntime } from '../../src/service/worker-runtime.js'
import type { WdioPuppeteerVideoServiceOptions } from '../../src/types.js'

type WorkerBrowser = Parameters<WdioPuppeteerVideoWorkerRuntime['before']>[2]

const createWorker = async (
  options: {
    config?: Record<string, unknown>
    isBidi?: boolean
    capabilities?: Record<string, unknown>
    service?: WdioPuppeteerVideoServiceOptions
  } = {},
) => {
  vi.spyOn(PuppeteerCaptureEngine.prototype, 'warmUp').mockResolvedValue()
  const follower = {
    after: vi
      .spyOn(ContextFollower.prototype, 'afterCommand')
      .mockResolvedValue(),
    before: vi
      .spyOn(ContextFollower.prototype, 'beforeCommand')
      .mockResolvedValue(),
    reset: vi.spyOn(ContextFollower.prototype, 'reset'),
  }
  const windows = {
    after: vi
      .spyOn(RecordingController.prototype, 'afterWindowCommand')
      .mockResolvedValue(),
    before: vi
      .spyOn(RecordingController.prototype, 'beforeWindowCommand')
      .mockResolvedValue(),
  }
  const available = { value: true }
  const coordinator: WorkerRecordingCoordinatorPort = {
    framework: 'mocha',
    isSpecScope: false,
    beginEntity: vi.fn(async () => {}),
    beginWorker: vi.fn(),
    configureSession: vi.fn(),
    endEntity: vi.fn(async () => {}),
    finalizeSpecRecording: vi.fn(async () => {}),
    resetWorkerState: vi.fn(),
  }
  const writeLog = vi.fn()
  const config = { framework: 'mocha', ...options.config }
  assignLauncherWorkerContext(config, true, 'bidi-routing')
  assignManifestRunContext(config, {
    runId: 'bidi-routing',
    outputDir: path.resolve('tests/results/bidi-routing'),
    startedAt: '2026-10-28T00:00:00.000Z',
    tools: {
      service: '2.0.0',
      node: process.version,
      webdriverio: '10.1.0',
      puppeteer: '25.16.0',
    },
  })
  assignManifestWorkerContext(config, '0-0', { specFileRetryAttempt: 0 })
  const worker = new WdioPuppeteerVideoWorkerRuntime(
    { logLevel: 'warn', ...options.service },
    undefined,
    config,
    {
      createRecordingCoordinator: (setup) => {
        available.value = setup.actions.getAvailability().available
        return {
          ...coordinator,
          beginEntity: vi.fn(async () => {
            available.value = setup.actions.getAvailability().available
          }),
        }
      },
      fileSystem: { ...nodeFileSystem, mkdir: vi.fn(async () => {}) },
      writeLog,
    },
  )
  const capabilities = { browserName: 'chrome', ...options.capabilities }
  const browser = {
    sessionId: 'session-1',
    capabilities,
    isBidi: options.isBidi ?? true,
    isMultiRemote: false,
  }
  await worker.beforeSession(config, capabilities, ['tabs.spec.ts'], '0-0')
  await worker.before(capabilities, ['tabs.spec.ts'], browser as WorkerBrowser)
  return { available, browser, follower, windows, worker, writeLog }
}

const warnedAbout = (writeLog: ReturnType<typeof vi.fn>, text: string) =>
  writeLog.mock.calls.some(
    ([, level, message]) => level === 'warn' && String(message).includes(text),
  )

afterEach(() => {
  vi.restoreAllMocks()
})

describe('worker runtime in WebDriver BiDi sessions', () => {
  it('routes command hooks with their arguments to the context follower', async () => {
    const { follower, windows, worker } = await createWorker()
    const error = new Error('failed')

    await worker.beforeCommand('browsingContextLocateNodes', [{ context: 'a' }])
    await worker.afterCommand('url', ['/'], { contextId: 'a' }, error)

    expect(follower.before).toHaveBeenCalledWith('browsingContextLocateNodes', [
      { context: 'a' },
    ])
    expect(follower.after).toHaveBeenCalledWith(
      'url',
      ['/'],
      { contextId: 'a' },
      error,
    )
    expect(windows.before).not.toHaveBeenCalled()
    expect(windows.after).not.toHaveBeenCalled()
  })

  it('keeps Classic sessions and ignored window changes on window commands', async () => {
    const classic = await createWorker({ isBidi: false })
    await classic.worker.beforeCommand('switchToWindow', ['a'])
    await classic.worker.afterCommand('switchToWindow')
    expect(classic.windows.before).toHaveBeenCalledWith('switchToWindow')
    expect(classic.windows.after).toHaveBeenCalledWith('switchToWindow')
    expect(classic.follower.before).not.toHaveBeenCalled()
    vi.restoreAllMocks()

    const ignoring = await createWorker({
      service: { recording: { windowChanges: 'ignore' } },
    })
    await ignoring.worker.beforeCommand('switchToWindow', ['a'])
    expect(ignoring.follower.before).not.toHaveBeenCalled()
  })

  it('never routes the service’s own commands', async () => {
    const { follower, windows, worker } = await createWorker()

    await runInternal(async () => {
      await worker.beforeCommand('scriptCallFunction', [{}])
      await worker.afterCommand('scriptCallFunction', [{}], undefined)
    })

    expect(follower.before).not.toHaveBeenCalled()
    expect(follower.after).not.toHaveBeenCalled()
    expect(windows.before).not.toHaveBeenCalled()
  })

  it('declines to record when parallel mode will run', async () => {
    const { available, follower, worker, writeLog } = await createWorker({
      capabilities: { 'wdio:experimentalBiDiCommands': true },
      config: { mochaOpts: { parallelMode: 'contexts' } },
    })

    await worker.beforeCommand('browsingContextNavigate', [{ context: 'a' }])
    await worker.beforeTest({ title: 't', parent: 's' } as never, undefined)

    expect(warnedAbout(writeLog, 'parallelMode')).toBe(true)
    expect(follower.before).not.toHaveBeenCalled()
    expect(available.value).toBe(false)
  })

  it('declines to record a test or scenario in a parallel-mode context', async () => {
    const test = await createWorker()
    Reflect.set(test.browser, '__parallelContextStore', {
      getStore: () => 'context-1',
    })
    await test.worker.beforeTest(
      { title: 't', parent: 's' } as never,
      undefined,
    )
    expect(warnedAbout(test.writeLog, 'parallelMode')).toBe(true)
    expect(test.available.value).toBe(false)
    vi.restoreAllMocks()

    const scenario = await createWorker({ config: { framework: 'cucumber' } })
    Reflect.set(scenario.browser, '__parallelContextStore', {
      getStore: () => 'context-2',
    })
    await scenario.worker.beforeScenario(
      {
        pickle: { name: 'scenario', uri: 'a.feature', tags: [] },
      } as never,
      undefined,
    )
    expect(warnedAbout(scenario.writeLog, 'parallelMode')).toBe(true)
  })

  it('checks a reloaded session again', async () => {
    const { browser, follower, windows, worker, writeLog } =
      await createWorker()
    follower.reset.mockClear()

    browser.isBidi = false
    await worker.onReload('session-1', 'session-2')
    await worker.beforeCommand('switchToWindow', ['a'])

    expect(follower.reset).toHaveBeenCalledOnce()
    expect(windows.before).toHaveBeenCalledWith('switchToWindow')

    Object.assign(browser.capabilities, {
      'wdio:experimentalBiDiCommands': true,
    })
    browser.isBidi = true
    await worker.onReload('session-2', 'session-3')
    expect(warnedAbout(writeLog, 'parallelMode')).toBe(false)
  })

  it('stops recording a reloaded session that is not Chromium', async () => {
    const { browser, follower, worker } = await createWorker()

    Object.assign(browser.capabilities, { browserName: 'firefox' })
    await worker.onReload('session-1', 'session-2')
    await worker.beforeCommand('browsingContextNavigate', [{ context: 'a' }])

    expect(follower.before).not.toHaveBeenCalled()
  })
})
