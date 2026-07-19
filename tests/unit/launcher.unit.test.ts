import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initializeLauncherService } from '@wdio/utils'
import { afterEach, describe, expect, it } from 'vitest'
import WdioPuppeteerVideoLauncher from '../../src/launcher.js'
import { writeReporterFragment } from '../../src/reporter/fragments.js'
import {
  assignLauncherWorkerContext,
  inspectLauncherWorkerContext,
  LAUNCHER_WORKER_CONFIG_KEY,
} from '../../src/service/launcher-context.js'
import {
  assignManifestWorkerContext,
  readManifestRunContext,
  readManifestWorkerContext,
} from '../../src/service/manifest-runtime.js'
import WdioPuppeteerVideoService from '../../src/service.js'

const tempDirs: string[] = []

const createTempDir = async (): Promise<string> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-launcher-'))
  tempDirs.push(tempDir)
  return tempDir
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((tempDir) => fs.rm(tempDir, { force: true, recursive: true })),
  )
})

describe('WdioPuppeteerVideoLauncher', () => {
  it('passes versioned run and CID-scoped retry contexts to workers', async () => {
    const outputDir = await createTempDir()
    const launcher = new WdioPuppeteerVideoLauncher({
      outputDir,
      recording: { attempts: 'retries' },
    })
    const sharedArgs: Record<string, unknown> = {}
    const capabilities = { browserName: 'chrome' }
    const specs = ['tests/specs/retry.ts']

    await launcher.onPrepare()
    launcher.onWorkerStart('0-0', capabilities, specs, sharedArgs)
    const firstWorkerArgs = { ...sharedArgs }
    launcher.onWorkerStart('0-1', capabilities, specs, sharedArgs)
    const concurrentWorkerArgs = { ...sharedArgs }
    launcher.onWorkerStart('0-0', capabilities, specs, sharedArgs)
    const retryWorkerArgs = { ...sharedArgs }

    expect(inspectLauncherWorkerContext(firstWorkerArgs)).toMatchObject({
      status: 'valid',
      context: { initialized: true, manifestContextAvailable: true },
    })
    expect(readManifestRunContext(firstWorkerArgs)).toBeDefined()
    expect(readManifestWorkerContext(firstWorkerArgs, '0-0')).toEqual({
      specFileRetryAttempt: 0,
    })
    expect(readManifestWorkerContext(concurrentWorkerArgs, '0-1')).toEqual({
      specFileRetryAttempt: 0,
    })
    expect(readManifestWorkerContext(retryWorkerArgs, '0-0')).toEqual({
      specFileRetryAttempt: 1,
    })

    const worker = new WdioPuppeteerVideoService(
      { outputDir, recording: { attempts: 'retries' } },
      capabilities,
      retryWorkerArgs,
    ) as unknown as {
      _specFileRetryAttempt: number
      beforeSession: (
        config: unknown,
        workerCapabilities: WebdriverIO.Capabilities,
        workerSpecs: string[],
        cid: string,
      ) => Promise<void>
    }
    await worker.beforeSession(retryWorkerArgs, capabilities, specs, '0-0')
    expect(worker._specFileRetryAttempt).toBe(1)

    await launcher.onComplete(0)
    await expect(
      fs.stat(path.join(outputDir, 'manifest.json')),
    ).resolves.toBeDefined()
  })

  it('rejects direct imported-class registration through WDIO initialization', async () => {
    await expect(
      initializeLauncherService(
        {
          services: [[WdioPuppeteerVideoService, {}]],
        } as never,
        [] as never,
      ),
    ).rejects.toThrow("services: [['puppeteer-video', options]]")
  })

  it('rejects missing and malformed launcher boundary data', () => {
    expect(inspectLauncherWorkerContext(undefined)).toEqual({
      status: 'missing',
    })
    expect(inspectLauncherWorkerContext([])).toEqual({ status: 'missing' })
    expect(
      inspectLauncherWorkerContext({
        [LAUNCHER_WORKER_CONFIG_KEY]: null,
      }),
    ).toEqual({ status: 'malformed' })

    expect(
      () => new WdioPuppeteerVideoService({}, {}, { services: [] }),
    ).toThrow('Direct class registration')

    expect(
      () =>
        new WdioPuppeteerVideoService(
          {},
          {},
          {
            [LAUNCHER_WORKER_CONFIG_KEY]: {
              initialized: true,
              manifestContextAvailable: false,
              version: 2,
            },
          },
        ),
    ).toThrow('malformed or from an unsupported version')

    const missingRetryContext: Record<string, unknown> = {}
    assignLauncherWorkerContext(missingRetryContext, false)
    expect(
      () => new WdioPuppeteerVideoService({}, {}, missingRetryContext),
    ).toThrow('launcher context is malformed')

    const missingManifestContext: Record<string, unknown> = {}
    assignLauncherWorkerContext(missingManifestContext, true)
    assignManifestWorkerContext(missingManifestContext, '0-0', {
      specFileRetryAttempt: 0,
    })
    expect(
      () => new WdioPuppeteerVideoService({}, {}, missingManifestContext),
    ).toThrow('launcher context is malformed')
  })

  it('accepts a launcher-authorized worker when manifest setup is unavailable', () => {
    const config: Record<string, unknown> = {}
    assignLauncherWorkerContext(config, false)
    assignManifestWorkerContext(config, '0-0', { specFileRetryAttempt: 0 })

    expect(() => new WdioPuppeteerVideoService({}, {}, config)).not.toThrow()
  })

  it('rejects a worker context that does not contain its CID', async () => {
    const config: Record<string, unknown> = {}
    assignLauncherWorkerContext(config, false)
    assignManifestWorkerContext(config, '0-0', { specFileRetryAttempt: 0 })
    const worker = new WdioPuppeteerVideoService()

    await expect(
      worker.beforeSession(
        config,
        { browserName: 'chrome' },
        ['tests/specs/example.ts'],
        '0-1',
      ),
    ).rejects.toThrow('launcher context is malformed')
  })

  it('requires onPrepare and a mutable worker argument boundary', async () => {
    const launcher = new WdioPuppeteerVideoLauncher({
      outputDir: await createTempDir(),
    })

    expect(() =>
      launcher.onWorkerStart(
        '0-0',
        { browserName: 'chrome' },
        ['tests/specs/example.ts'],
        {},
      ),
    ).toThrow('launcher context is missing')

    await launcher.onPrepare()
    expect(() =>
      launcher.onWorkerStart('0-0', { browserName: 'chrome' }, [
        'tests/specs/example.ts',
      ]),
    ).toThrow('launcher context is missing')
    await launcher.onComplete(0)
  })

  it('applies failurePolicy when launcher manifest initialization fails', async () => {
    const tempDir = await createTempDir()
    const blockedOutput = path.join(tempDir, 'blocked-output')
    await fs.writeFile(blockedOutput, 'not-a-directory')

    const warningLauncher = new WdioPuppeteerVideoLauncher({
      outputDir: blockedOutput,
      failurePolicy: 'warn',
      logLevel: 'silent',
    })
    await expect(warningLauncher.onPrepare()).resolves.toBeUndefined()
    const workerArgs: Record<string, unknown> = {}
    warningLauncher.onWorkerStart(
      '0-0',
      { browserName: 'chrome' },
      ['tests/specs/example.ts'],
      workerArgs,
    )
    expect(inspectLauncherWorkerContext(workerArgs)).toMatchObject({
      status: 'valid',
      context: { manifestContextAvailable: false },
    })
    await expect(warningLauncher.onComplete(0)).resolves.toBeUndefined()

    const errorLauncher = new WdioPuppeteerVideoLauncher({
      outputDir: blockedOutput,
      failurePolicy: 'error',
      logLevel: 'silent',
    })
    await expect(errorLauncher.onPrepare()).rejects.toBeDefined()
  })

  it('applies failurePolicy when manifest aggregation fails', async () => {
    const outputDir = await createTempDir()
    const warningLauncher = new WdioPuppeteerVideoLauncher({
      outputDir,
      failurePolicy: 'warn',
      logLevel: 'silent',
    })
    await warningLauncher.onPrepare()
    await fs.writeFile(path.join(outputDir, 'manifest.json'), 'invalid-json')
    await expect(warningLauncher.onComplete(0)).resolves.toBeUndefined()

    const errorOutputDir = await createTempDir()
    const errorLauncher = new WdioPuppeteerVideoLauncher({
      outputDir: errorOutputDir,
      failurePolicy: 'error',
      logLevel: 'silent',
    })
    await errorLauncher.onPrepare()
    await fs.writeFile(
      path.join(errorOutputDir, 'manifest.json'),
      'invalid-json',
    )
    await expect(errorLauncher.onComplete(0)).rejects.toBeDefined()
  })

  it('applies failurePolicy when static report generation fails', async () => {
    const createFailingLauncher = async (
      failurePolicy: 'error' | 'warn',
    ): Promise<WdioPuppeteerVideoLauncher> => {
      const outputDir = await createTempDir()
      const launcher = new WdioPuppeteerVideoLauncher({
        outputDir,
        failurePolicy,
        logLevel: 'silent',
      })
      const workerArgs: Record<string, unknown> = {}
      await launcher.onPrepare()
      launcher.onWorkerStart(
        '0-0',
        { browserName: 'chrome' },
        ['tests/specs/example.ts'],
        workerArgs,
      )
      const context = readManifestRunContext(workerArgs)
      if (!context) {
        throw new TypeError('Expected launcher manifest context')
      }
      await writeReporterFragment(outputDir, {
        schemaVersion: 1,
        runId: context.runId,
        cid: '0-0',
        specs: ['tests/specs/example.ts'],
        browser: { name: 'chrome' },
        reportFileName: 'video-report.html',
        startedAt: '2026-07-18T00:00:00.000Z',
        completedAt: '2026-07-18T00:00:01.000Z',
        outcomes: [],
      })
      await fs.mkdir(path.join(outputDir, 'video-report.html'))
      return launcher
    }

    await expect(
      (await createFailingLauncher('warn')).onComplete(0),
    ).resolves.toBeUndefined()
    await expect(
      (await createFailingLauncher('error')).onComplete(0),
    ).rejects.toBeDefined()
  })
})
