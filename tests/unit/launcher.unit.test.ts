import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initializeLauncherService } from '@wdio/utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WdioPuppeteerVideoLauncher from '../../src/launcher.js'
import { writeReporterFragment } from '../../src/reporter/fragments.js'
import { generateVideoReportForRun } from '../../src/reporter/report-generator.js'
import type { LauncherCompositionOverrides } from '../../src/service/composition.js'
import { resolveGlobalSlotRunDirectories } from '../../src/service/global-slot-directory.js'
import {
  assignLauncherWorkerContext,
  inspectLauncherWorkerContext,
  LAUNCHER_WORKER_CONFIG_KEY,
} from '../../src/service/launcher-context.js'
import {
  aggregateManifestRun,
  assignManifestWorkerContext,
  readManifestRunContext,
  readManifestWorkerContext,
} from '../../src/service/manifest-runtime.js'
import {
  createMatroskaHeader,
  MatroskaBlockWriter,
} from '../../src/service/matroska-writer.js'
import { recoverOrphanedSpools } from '../../src/service/spool-recovery.js'
import type { WorkerRecordingCoordinatorPort } from '../../src/service/worker-recording-coordinator.js'
import WdioPuppeteerVideoService from '../../src/service.js'
import { spoolName } from '../utils/spool-fixtures.js'

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
  it.each(['success', 'initialization', 'aggregation', 'report'] as const)(
    'cleans its run namespace after %s while preserving sibling runs',
    async (failurePhase) => {
      const outputDir = await createTempDir()
      const lockDir = path.join(outputDir, 'shared-locks')
      const failure = new Error(`${failurePhase} failure`)
      const fail = async (): Promise<never> => {
        throw failure
      }
      const overrides: LauncherCompositionOverrides = {
        uuid: () => 'current-run',
        ...(failurePhase === 'initialization'
          ? { createManifestRunContext: fail }
          : {}),
        ...(failurePhase === 'aggregation'
          ? { aggregateManifestRun: fail }
          : {}),
        ...(failurePhase === 'report'
          ? { generateVideoReportForRun: fail }
          : {}),
      }
      const launcher = new WdioPuppeteerVideoLauncher(
        {
          outputDir,
          concurrency: { lockDir },
          logLevel: 'silent',
          failurePolicy: failurePhase === 'initialization' ? 'warn' : 'error',
        },
        undefined,
        undefined,
        overrides,
      )
      await launcher.onPrepare()
      const args = {}
      launcher.onWorkerStart(
        '0-0',
        { browserName: 'chrome' },
        ['spec.ts'],
        args,
      )
      expect(inspectLauncherWorkerContext(args)).toMatchObject({
        status: 'valid',
        context: { runId: 'current-run', version: 2 },
      })
      if (failurePhase !== 'initialization') {
        expect(readManifestRunContext(args)?.runId).toBe('current-run')
      }
      const current = resolveGlobalSlotRunDirectories({
        lockDir,
        runId: 'current-run',
      })
      await fs.mkdir(current.postProcess, { recursive: true })
      await fs.writeFile(
        path.join(current.postProcess, 'slot-1.lock'),
        'abandoned',
      )
      await fs.mkdir(path.join(lockDir, 'other-run'))
      const completion = launcher.onComplete()
      if (failurePhase === 'aggregation' || failurePhase === 'report') {
        await expect(completion).rejects.toBe(failure)
      } else {
        await expect(completion).resolves.toBeUndefined()
      }
      expect(await fs.readdir(lockDir)).toEqual(['other-run'])
      await expect(launcher.onComplete()).resolves.toBeUndefined()
    },
  )

  it('warns on run cleanup failure without masking the completion error', async () => {
    const outputDir = await createTempDir()
    const failure = new Error('aggregation failed')
    const writeLog = vi.fn()
    const launcher = new WdioPuppeteerVideoLauncher(
      { outputDir, failurePolicy: 'error' },
      undefined,
      undefined,
      {
        aggregateManifestRun: async () => {
          throw failure
        },
        cleanupGlobalSlotRunDirectory: async () => {
          throw new Error('cleanup failed')
        },
        writeLog,
      },
    )
    await launcher.onPrepare()
    await expect(launcher.onComplete()).rejects.toBe(failure)
    expect(
      writeLog.mock.calls.some((call) =>
        call[2].includes('Later runs remain isolated'),
      ),
    ).toBe(true)
  })

  describe('orphaned spool recovery', () => {
    const track = { codec: 'png', fps: 25, height: 600, width: 800 } as const

    const spoolStream = (): Buffer =>
      Buffer.concat([
        createMatroskaHeader(track),
        ...new MatroskaBlockWriter().frame(Buffer.alloc(32, 7), 0),
      ])

    const prepare = async (
      outputDir: string,
      overrides: LauncherCompositionOverrides = {},
      options: { failurePolicy?: 'error' | 'warn' } = {},
    ) => {
      const writeLog = vi.fn()
      const launcher = new WdioPuppeteerVideoLauncher(
        { outputDir, ...options },
        undefined,
        undefined,
        { uuid: () => 'current-run', writeLog, ...overrides },
      )
      await launcher.onPrepare()
      return { launcher, writeLog }
    }

    const warnings = (writeLog: ReturnType<typeof vi.fn>): string[] =>
      writeLog.mock.calls
        .filter((call) => call[1] === 'warn')
        .map((call) => String(call[2]))

    it('recovers the run spools after the manifest and report steps, then removes the directory', async () => {
      const outputDir = await createTempDir()
      const order: string[] = []
      const { launcher, writeLog } = await prepare(outputDir, {
        aggregateManifestRun: async (context, exitCode) => {
          order.push('manifest')
          return aggregateManifestRun(context, exitCode)
        },
        cleanupGlobalSlotRunDirectory: async () => {
          order.push('slots')
        },
        generateVideoReportForRun: async (options) => {
          order.push('report')
          return generateVideoReportForRun(options)
        },
        recoverOrphanedSpools: async (options) => {
          order.push('spools')
          return recoverOrphanedSpools(options)
        },
      })
      const spoolRoot = path.join(outputDir, '.wdio-video-spool')
      const runDirectory = path.join(spoolRoot, 'current-run')
      await fs.mkdir(runDirectory, { recursive: true })
      const stream = spoolStream()
      await fs.writeFile(
        path.join(runDirectory, spoolName('checkout', 1)),
        stream,
      )
      await fs.writeFile(
        path.join(runDirectory, spoolName('checkout', 2)),
        createMatroskaHeader(track),
      )
      await fs.mkdir(path.join(spoolRoot, 'other-run'))

      await launcher.onComplete()

      expect(order).toEqual(['manifest', 'report', 'spools', 'slots'])
      expect(
        await fs.readFile(path.join(outputDir, 'checkout_part1.frames.mkv')),
      ).toEqual(stream)
      await expect(fs.stat(runDirectory)).rejects.toThrow()
      expect(await fs.readdir(spoolRoot)).toEqual(['other-run'])
      expect(warnings(writeLog)).toEqual([
        expect.stringContaining('checkout_part1.frames.mkv'),
      ])
    })

    it('removes the empty spool directory a clean run leaves', async () => {
      const outputDir = await createTempDir()
      const { launcher, writeLog } = await prepare(outputDir)
      await fs.mkdir(path.join(outputDir, '.wdio-video-spool', 'current-run'), {
        recursive: true,
      })

      await launcher.onComplete()

      expect(await fs.readdir(outputDir)).not.toContain('.wdio-video-spool')
      expect(warnings(writeLog)).toEqual([])
    })

    it('does not warn or fail when the run has no spool directory', async () => {
      const outputDir = await createTempDir()
      const { launcher, writeLog } = await prepare(
        outputDir,
        {},
        { failurePolicy: 'error' },
      )

      await expect(launcher.onComplete()).resolves.toBeUndefined()

      expect(warnings(writeLog)).toEqual([])
      expect(await fs.readdir(outputDir)).not.toContain('.wdio-video-spool')
    })

    it('passes the output directory and this run id to the recovery', async () => {
      const outputDir = await createTempDir()
      const recoverOrphanedSpools = vi.fn(async () => undefined)
      const { launcher } = await prepare(outputDir, { recoverOrphanedSpools })

      await launcher.onComplete()

      expect(recoverOrphanedSpools).toHaveBeenCalledOnce()
      expect(recoverOrphanedSpools).toHaveBeenCalledWith({
        log: expect.any(Function),
        outputDir,
        runId: 'current-run',
      })
    })

    it('warns and completes when the recovery fails under failurePolicy warn', async () => {
      const outputDir = await createTempDir()
      const cleanupGlobalSlotRunDirectory = vi.fn(async () => undefined)
      const { launcher, writeLog } = await prepare(
        outputDir,
        {
          cleanupGlobalSlotRunDirectory,
          recoverOrphanedSpools: async () => {
            throw new Error('disk on fire')
          },
        },
        { failurePolicy: 'warn' },
      )

      await expect(launcher.onComplete()).resolves.toBeUndefined()

      expect(warnings(writeLog)).toEqual([
        expect.stringContaining(
          'Failed to recover orphaned frame spools: disk on fire',
        ),
      ])
      expect(cleanupGlobalSlotRunDirectory).toHaveBeenCalledOnce()
    })

    it('throws when the recovery fails under failurePolicy error, after the slots are cleaned', async () => {
      const outputDir = await createTempDir()
      const failure = new Error('disk on fire')
      const cleanupGlobalSlotRunDirectory = vi.fn(async () => undefined)
      const { launcher, writeLog } = await prepare(
        outputDir,
        {
          cleanupGlobalSlotRunDirectory,
          recoverOrphanedSpools: async () => {
            throw failure
          },
        },
        { failurePolicy: 'error' },
      )

      await expect(launcher.onComplete()).rejects.toBe(failure)

      expect(warnings(writeLog)).toEqual([
        expect.stringContaining('Failed to recover orphaned frame spools'),
      ])
      expect(cleanupGlobalSlotRunDirectory).toHaveBeenCalledOnce()
    })

    it('throws the manifest error, not the later recovery error, and logs both', async () => {
      const outputDir = await createTempDir()
      const manifestFailure = new Error('aggregation failed')
      const cleanupGlobalSlotRunDirectory = vi.fn(async () => undefined)
      const { launcher, writeLog } = await prepare(
        outputDir,
        {
          aggregateManifestRun: async () => {
            throw manifestFailure
          },
          cleanupGlobalSlotRunDirectory,
          recoverOrphanedSpools: async () => {
            throw new Error('disk on fire')
          },
        },
        { failurePolicy: 'error' },
      )

      await expect(launcher.onComplete()).rejects.toBe(manifestFailure)

      expect(warnings(writeLog)).toEqual([
        expect.stringContaining(
          'Failed to aggregate manifest journals: aggregation failed',
        ),
        expect.stringContaining(
          'Failed to recover orphaned frame spools: disk on fire',
        ),
      ])
      expect(cleanupGlobalSlotRunDirectory).toHaveBeenCalledOnce()
    })

    it('throws the recovery error when nothing failed before it', async () => {
      const outputDir = await createTempDir()
      const recoveryFailure = new Error('disk on fire')
      const { launcher, writeLog } = await prepare(
        outputDir,
        {
          recoverOrphanedSpools: async () => {
            throw recoveryFailure
          },
        },
        { failurePolicy: 'error' },
      )

      await expect(launcher.onComplete()).rejects.toBe(recoveryFailure)

      expect(warnings(writeLog)).toEqual([
        expect.stringContaining('Failed to recover orphaned frame spools'),
      ])
    })

    it('throws nothing under failurePolicy warn and logs every failure', async () => {
      const outputDir = await createTempDir()
      const { launcher, writeLog } = await prepare(
        outputDir,
        {
          aggregateManifestRun: async () => {
            throw new Error('aggregation failed')
          },
          recoverOrphanedSpools: async () => {
            throw new Error('disk on fire')
          },
        },
        { failurePolicy: 'warn' },
      )

      await expect(launcher.onComplete()).resolves.toBeUndefined()

      expect(warnings(writeLog)).toEqual([
        expect.stringContaining('Failed to aggregate manifest journals'),
        expect.stringContaining('Failed to recover orphaned frame spools'),
      ])
    })

    it('refuses a run directory that is a link and leaves its target alone', async () => {
      const outputDir = await createTempDir()
      const elsewhere = await createTempDir()
      const victim = path.join(elsewhere, spoolName('a', 1))
      await fs.writeFile(victim, spoolStream())
      const { launcher, writeLog } = await prepare(outputDir)
      await fs.mkdir(path.join(outputDir, '.wdio-video-spool'))
      await fs.symlink(
        elsewhere,
        path.join(outputDir, '.wdio-video-spool', 'current-run'),
        'junction',
      )

      await expect(launcher.onComplete()).resolves.toBeUndefined()

      expect((await fs.stat(victim)).size).toBeGreaterThan(0)
      expect(warnings(writeLog)).toEqual([
        expect.stringContaining('not a plain directory'),
      ])
    })

    it('refuses a spool root that is a link and leaves the run behind it alone', async () => {
      const outputDir = await createTempDir()
      const elsewhere = await createTempDir()
      await fs.mkdir(path.join(elsewhere, 'current-run'))
      const frameless = path.join(elsewhere, 'current-run', spoolName('a', 1))
      const victim = path.join(elsewhere, 'current-run', spoolName('b', 1))
      await fs.writeFile(frameless, createMatroskaHeader(track))
      await fs.writeFile(victim, spoolStream())
      const { launcher, writeLog } = await prepare(outputDir)
      const spoolRoot = path.join(outputDir, '.wdio-video-spool')
      await fs.symlink(elsewhere, spoolRoot, 'junction')

      try {
        await expect(launcher.onComplete()).resolves.toBeUndefined()

        expect(await fs.readFile(frameless)).toEqual(
          createMatroskaHeader(track),
        )
        expect(await fs.readFile(victim)).toEqual(spoolStream())
        expect(
          (await fs.readdir(outputDir)).filter((name) =>
            name.endsWith('.frames.mkv'),
          ),
        ).toEqual([])
        expect(warnings(writeLog)).toEqual([
          expect.stringContaining('not a plain directory'),
        ])
      } finally {
        await fs.unlink(spoolRoot).catch(() => undefined)
      }
    })
  })

  it('mints a fresh run identity each time a launcher is prepared', async () => {
    const launcher = new WdioPuppeteerVideoLauncher({
      outputDir: await createTempDir(),
    })
    const identities: unknown[] = []
    for (let index = 0; index < 2; index += 1) {
      await launcher.onPrepare()
      const args = {}
      launcher.onWorkerStart('0-0', {}, ['spec.ts'], args)
      const context = inspectLauncherWorkerContext(args)
      expect(context.status).toBe('valid')
      identities.push(
        context.status === 'valid' ? context.context.runId : undefined,
      )
      await launcher.onComplete()
    }
    expect(new Set(identities).size).toBe(2)
  })

  it('passes versioned run and policy-independent retry contexts to workers', async () => {
    const outputDir = await createTempDir()
    const launcher = new WdioPuppeteerVideoLauncher({
      outputDir,
      recording: { attempts: 'all', retain: 'retries' },
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

    let hydratedRetryAttempt: number | undefined
    const coordinator: WorkerRecordingCoordinatorPort = {
      framework: 'unknown',
      isSpecScope: false,
      beginEntity: vi.fn(async () => {}),
      beginWorker: vi.fn(),
      configureSession: (session) => {
        hydratedRetryAttempt = session.specFileRetryAttempt
      },
      endEntity: vi.fn(async () => {}),
      finalizeSpecRecording: vi.fn(async () => {}),
      resetWorkerState: vi.fn(),
    }
    const worker = new WdioPuppeteerVideoService(
      { outputDir, recording: { attempts: 'all', retain: 'retries' } },
      capabilities,
      retryWorkerArgs,
      { createRecordingCoordinator: () => coordinator },
    )
    await worker.beforeSession(retryWorkerArgs, capabilities, specs, '0-0')
    expect(hydratedRetryAttempt).toBe(1)

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
    assignLauncherWorkerContext(missingRetryContext, false, 'test-run')
    expect(
      () => new WdioPuppeteerVideoService({}, {}, missingRetryContext),
    ).toThrow('launcher context is malformed')

    const missingManifestContext: Record<string, unknown> = {}
    assignLauncherWorkerContext(missingManifestContext, true, 'test-run')
    assignManifestWorkerContext(missingManifestContext, '0-0', {
      specFileRetryAttempt: 0,
    })
    expect(
      () => new WdioPuppeteerVideoService({}, {}, missingManifestContext),
    ).toThrow('launcher context is malformed')
  })

  it('accepts a launcher-authorized worker when manifest setup is unavailable', () => {
    const config: Record<string, unknown> = {}
    assignLauncherWorkerContext(config, false, 'test-run')
    assignManifestWorkerContext(config, '0-0', { specFileRetryAttempt: 0 })

    expect(() => new WdioPuppeteerVideoService({}, {}, config)).not.toThrow()
  })

  it('rejects unsafe run identities and mismatched manifest/slot run contexts', async () => {
    expect(() => assignLauncherWorkerContext({}, false, '../unsafe')).toThrow(
      'malformed',
    )
    const launcher = new WdioPuppeteerVideoLauncher({
      outputDir: await createTempDir(),
    })
    await launcher.onPrepare()
    const config = {}
    launcher.onWorkerStart(
      '0-0',
      { browserName: 'chrome' },
      ['spec.ts'],
      config,
    )
    assignLauncherWorkerContext(config, true, 'different-run')
    expect(() => new WdioPuppeteerVideoService({}, {}, config)).toThrow(
      'malformed',
    )
    await launcher.onComplete()
  })

  it('rejects a worker context that does not contain its CID', async () => {
    const config: Record<string, unknown> = {}
    assignLauncherWorkerContext(config, false, 'test-run')
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
