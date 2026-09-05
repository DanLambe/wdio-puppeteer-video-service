import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Frameworks } from '@wdio/types'
import { afterEach, describe, expect, it } from 'vitest'
import WdioPuppeteerVideoLauncher from '../../src/launcher.js'
import { isVideoManifest, type VideoManifestV1 } from '../../src/manifest.js'
import { assignLauncherWorkerContext } from '../../src/service/launcher-context.js'
import {
  aggregateManifestRun,
  assignManifestRunContext,
  assignManifestWorkerContext,
  createManifestRunContext,
  type ManifestRunContext,
} from '../../src/service/manifest-runtime.js'
import {
  createWorkerRecordingCoordinator,
  type WorkerRecordingCoordinatorPort,
} from '../../src/service/worker-recording-coordinator.js'
import WdioPuppeteerVideoService from '../../src/service.js'

const tempDirs: string[] = []

const createTempDir = async (): Promise<string> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manifest-'))
  tempDirs.push(tempDir)
  return tempDir
}

const createTest = (title: string, file: string): Frameworks.Test => ({
  type: 'test',
  title,
  fullTitle: `suite ${title}`,
  fullName: `suite ${title}`,
  parent: 'suite',
  pending: false,
  file,
  ctx: {},
})

const createBrowser = (browserName: string, sessionId = 'private-session-id') =>
  ({
    sessionId,
    capabilities: { browserName, browserVersion: '140.0.0' },
    options: { logLevel: 'silent' },
    isMultiremote: false,
  }) as never

const readManifest = async (outputDir: string): Promise<VideoManifestV1> => {
  const value = JSON.parse(
    await fs.readFile(path.join(outputDir, 'manifest.json'), 'utf8'),
  ) as unknown
  expect(isVideoManifest(value)).toBe(true)
  return value as VideoManifestV1
}

const assignWorkerConfiguration = (
  config: object,
  cid: string,
  context: ManifestRunContext,
  specFileRetryAttempt = 0,
): void => {
  assignLauncherWorkerContext(config, true, context.runId)
  assignManifestRunContext(config, context)
  assignManifestWorkerContext(config, cid, { specFileRetryAttempt })
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })),
  )
})

describe('service manifest hooks', () => {
  it('passes launcher state to a worker and publishes unsupported captures', async () => {
    const outputDir = await createTempDir()
    const spec = path.join(process.cwd(), 'tests', 'specs', 'unsupported.ts')
    const specs = [spec]
    const launcher = new WdioPuppeteerVideoLauncher({
      outputDir,
      recording: { attempts: 'retries' },
    })
    const workerConfig: Record<string, unknown> = { framework: 'mocha' }
    await launcher.onPrepare()
    await launcher.onWorkerStart(
      '0-0',
      { browserName: 'firefox' },
      specs,
      workerConfig,
    )

    const worker = new WdioPuppeteerVideoService({ outputDir })
    await worker.beforeSession(
      workerConfig,
      { browserName: 'firefox' },
      specs,
      '0-0',
    )
    await worker.before(
      { browserName: 'firefox' },
      specs,
      createBrowser('firefox'),
    )
    const test = createTest('unsupported capture', spec)
    await worker.beforeTest(test, {})
    await worker.afterTest(test, {}, { passed: false } as Frameworks.TestResult)
    await worker.afterSession()
    await launcher.onWorkerEnd('0-0', 1, specs, 0)
    await launcher.onComplete(1)

    const manifest = await readManifest(outputDir)
    expect(manifest.runs).toHaveLength(1)
    expect(manifest.runs[0]).toMatchObject({ exitCode: 1 })
    expect(manifest.runs[0]?.entries[0]).toMatchObject({
      framework: 'mocha',
      result: 'failed',
      capture: {
        decision: 'skipped',
        reason: 'recording-hooks-unavailable',
      },
      browser: { name: 'firefox', protocol: 'unsupported' },
    })
    expect(JSON.stringify(manifest)).not.toContain('private-session-id')
  })

  it('journals filter and retry decisions before recording starts', async () => {
    const outputDir = await createTempDir()
    const spec = path.join(process.cwd(), 'tests', 'specs', 'filtered.ts')
    const specs = [spec]
    const context = await createManifestRunContext(outputDir)
    const config: Record<string, unknown> = { framework: 'jasmine' }
    assignWorkerConfiguration(config, '1-0', context)
    const worker = new WdioPuppeteerVideoService({
      outputDir,
      recording: {
        filters: { excludeSpecs: ['*filtered.ts'] },
      },
    })
    await worker.beforeSession(config, { browserName: 'chrome' }, specs, '1-0')
    await worker.before(
      { browserName: 'chrome' },
      specs,
      createBrowser('chrome', 'filtered-session'),
    )
    await worker.beforeTest(createTest('filtered capture', spec), {})
    await worker.afterSession()

    const retryContext = await createManifestRunContext(outputDir)
    const retryConfig: Record<string, unknown> = { framework: 'mocha' }
    assignWorkerConfiguration(retryConfig, '1-1', retryContext)
    const retryWorker = new WdioPuppeteerVideoService({
      outputDir,
      recording: { attempts: 'retries' },
    })
    await retryWorker.beforeSession(
      retryConfig,
      { browserName: 'chrome' },
      specs,
      '1-1',
    )
    await retryWorker.before(
      { browserName: 'chrome' },
      specs,
      createBrowser('chrome', 'retry-session'),
    )
    await retryWorker.beforeTest(createTest('retry capture', spec), {})
    await retryWorker.afterSession()

    const [filteredManifest] = await Promise.all([
      aggregateManifestRun(context, 0),
      aggregateManifestRun(retryContext, 0),
    ])
    const manifest = await readManifest(outputDir)
    expect(
      filteredManifest.runs.find((run) => run.id === context.runId)?.entries[0]
        ?.capture.reason,
    ).toBe('filtered')
    expect(manifest.runs).toHaveLength(2)
    expect(
      manifest.runs
        .flatMap((run) => run.entries)
        .map((entry) => entry.capture.reason),
    ).toEqual(expect.arrayContaining(['filtered', 'not-a-retry-attempt']))
  })

  it('records Cucumber filter decisions and spec-scope identity', async () => {
    const outputDir = await createTempDir()
    const specs = [path.join(process.cwd(), 'features', 'manifest.feature')]
    const context = await createManifestRunContext(outputDir)
    const config: Record<string, unknown> = { framework: 'cucumber' }
    assignWorkerConfiguration(config, '2-0', context)
    const worker = new WdioPuppeteerVideoService({
      outputDir,
      recording: {
        scope: 'spec',
        filters: { excludeTags: ['@skip-video'] },
      },
    })
    await worker.beforeSession(config, { browserName: 'chrome' }, specs, '2-0')
    await worker.before(
      { browserName: 'chrome' },
      specs,
      createBrowser('chrome', 'cucumber-session'),
    )
    await worker.beforeScenario(
      {
        pickle: { name: 'filtered scenario', tags: [{ name: '@skip-video' }] },
      } as unknown as Frameworks.World,
      undefined,
    )
    await worker.afterScenario(
      {} as Frameworks.World,
      { passed: true } as Frameworks.PickleResult,
    )
    await worker.afterSession()

    const manifest = await aggregateManifestRun(context, 0)
    expect(manifest.runs[0]?.entries[0]).toMatchObject({
      framework: 'cucumber',
      scope: 'spec',
      capture: { decision: 'skipped', reason: 'filtered' },
    })
    expect(manifest.runs[0]?.entries[0]?.test).toBeUndefined()
  })

  it('flushes the manifest journal when teardown cleanup fails', async () => {
    const outputDir = await createTempDir()
    const spec = path.join(process.cwd(), 'tests', 'specs', 'manifest-flush.ts')
    const context = await createManifestRunContext(outputDir)
    const config: Record<string, unknown> = { framework: 'mocha' }
    assignWorkerConfiguration(config, '3-2', context)
    let failTeardown = true
    const service = new WdioPuppeteerVideoService(
      {
        outputDir,
        failurePolicy: 'error',
        recording: { filters: { excludeSpecs: ['*manifest-flush.ts'] } },
      },
      undefined,
      undefined,
      {
        createRecordingCoordinator(options) {
          const coordinator = createWorkerRecordingCoordinator(options)
          return {
            get framework() {
              return coordinator.framework
            },
            get isSpecScope() {
              return coordinator.isSpecScope
            },
            beginEntity: (entity) => coordinator.beginEntity(entity),
            beginWorker: (specPaths) => coordinator.beginWorker(specPaths),
            configureSession: (session) =>
              coordinator.configureSession(session),
            endEntity: (outcome) => coordinator.endEntity(outcome),
            finalizeSpecRecording: () => coordinator.finalizeSpecRecording(),
            resetWorkerState() {
              coordinator.resetWorkerState()
              if (failTeardown) {
                failTeardown = false
                throw new Error('teardown unavailable')
              }
            },
          } satisfies WorkerRecordingCoordinatorPort
        },
      },
    )
    const specs = [spec]
    await service.beforeSession(config, { browserName: 'chrome' }, specs, '3-2')
    await service.before(
      { browserName: 'chrome' },
      specs,
      createBrowser('chrome'),
    )
    await service.beforeTest(createTest('flush after teardown error', spec), {})

    await expect(service.afterSession()).rejects.toThrow('teardown unavailable')
    await expect(service.afterSession()).resolves.toBeUndefined()

    const manifest = await aggregateManifestRun(context, 0)
    expect(manifest.runs[0]?.entries[0]).toMatchObject({
      capture: { decision: 'skipped', reason: 'filtered' },
      test: { name: 'flush after teardown error' },
    })
  })
})
