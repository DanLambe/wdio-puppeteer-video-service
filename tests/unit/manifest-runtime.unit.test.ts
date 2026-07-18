import { writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ManifestEntryV1,
  ManifestRunV1,
  VideoManifestV1,
} from '../../src/manifest.js'
import { isVideoManifest } from '../../src/manifest.js'
import {
  aggregateManifestRun,
  assignManifestRunContext,
  createManifestRunContext,
  hashPrivateValue,
  MANIFEST_RUN_CONFIG_KEY,
  ManifestWorkerRecorder,
  normalizeManifestFramework,
  normalizeManifestPath,
  readManifestRunContext,
} from '../../src/service/manifest-runtime.js'

const tempDirs: string[] = []

const createTempDir = async (): Promise<string> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-v1-'))
  tempDirs.push(tempDir)
  return tempDir
}

const createRecorder = async (
  outputDir: string,
  cid = '0-0',
  framework: 'mocha' | 'jasmine' | 'cucumber' | 'unknown' = 'mocha',
) => {
  const context = await createManifestRunContext(outputDir)
  const recorder = new ManifestWorkerRecorder({ context, cid, framework })
  recorder.configureSession({
    sessionId: 'raw-private-session-id',
    browserName: 'chrome',
    browserVersion: '140.0.0',
    protocol: 'bidi+cdp',
  })
  return { context, recorder }
}

const journalDir = (outputDir: string, runId: string): string => {
  return path.join(outputDir, '.wdio-video-manifest', runId, 'journals')
}

const firstRun = (manifest: VideoManifestV1): ManifestRunV1 => {
  const run = manifest.runs[0]
  if (!run) {
    throw new TypeError('Expected a manifest run in test fixture')
  }
  return run
}

const firstEntry = (manifest: VideoManifestV1): ManifestEntryV1 => {
  const entry = firstRun(manifest).entries[0]
  if (!entry) {
    throw new TypeError('Expected a manifest entry in test fixture')
  }
  return entry
}

const firstString = (values: string[]): string => {
  const value = values[0]
  if (!value) {
    throw new TypeError('Expected a populated string array in test fixture')
  }
  return value
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    tempDirs
      .splice(0)
      .map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })),
  )
})

describe('manifest runtime', () => {
  it('warns and recovers when a journal append fails', async () => {
    const outputDir = await createTempDir()
    const context = await createManifestRunContext(outputDir)
    const onJournalError = vi.fn()
    const recorder = new ManifestWorkerRecorder({
      context,
      cid: 'policy-warn',
      framework: 'mocha',
      failurePolicy: 'warn',
      onJournalError,
    })
    const appendFile = vi
      .spyOn(fs, 'appendFile')
      .mockRejectedValueOnce(new Error('journal unavailable'))

    await expect(
      recorder.beginEntity({
        test: { title: 'warning policy', file: 'specs/warning.ts' },
        scope: 'test',
        specPaths: [],
      }),
    ).resolves.toEqual(expect.any(String))
    expect(onJournalError).toHaveBeenCalledWith(
      'write the worker manifest journal',
      expect.objectContaining({ message: 'journal unavailable' }),
    )

    appendFile.mockRestore()
    await recorder.completeCurrent({
      decision: 'skipped',
      result: 'passed',
    })
    await expect(recorder.flush()).resolves.toBeUndefined()
  })

  it('surfaces a journal append failure under the error policy', async () => {
    const outputDir = await createTempDir()
    const context = await createManifestRunContext(outputDir)
    const onJournalError = vi.fn()
    const recorder = new ManifestWorkerRecorder({
      context,
      cid: 'policy-error',
      framework: 'mocha',
      failurePolicy: 'error',
      onJournalError,
    })
    vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(
      new Error('journal unavailable'),
    )

    await expect(
      recorder.beginEntity({
        test: { title: 'error policy', file: 'specs/error.ts' },
        scope: 'test',
        specPaths: [],
      }),
    ).rejects.toThrow('journal unavailable')
    expect(onJournalError).toHaveBeenCalledOnce()
  })

  it('passes launcher context through worker config without global state', async () => {
    const outputDir = await createTempDir()
    const context = await createManifestRunContext(outputDir)
    const config = {}
    assignManifestRunContext(config, context)

    expect(readManifestRunContext(config)).toEqual(context)
    expect(config).toHaveProperty(MANIFEST_RUN_CONFIG_KEY)
    expect(readManifestRunContext(undefined)).toBeUndefined()
    expect(
      readManifestRunContext({ [MANIFEST_RUN_CONFIG_KEY]: null }),
    ).toBeUndefined()
    expect(
      readManifestRunContext({
        [MANIFEST_RUN_CONFIG_KEY]: {
          runId: context.runId,
          outputDir: 1,
          startedAt: context.startedAt,
          tools: context.tools,
        },
      }),
    ).toBeUndefined()
    expect(
      readManifestRunContext({
        [MANIFEST_RUN_CONFIG_KEY]: {
          runId: 1,
          outputDir,
          startedAt: '',
          tools: {},
        },
      }),
    ).toBeUndefined()
    for (const invalidContext of [
      { ...context, runId: ' ' },
      { ...context, outputDir: 'relative-output' },
      { ...context, startedAt: 'not-a-date' },
      { ...context, tools: [] },
      { ...context, tools: { ...context.tools, service: '' } },
      { ...context, tools: { ...context.tools, node: '' } },
      { ...context, tools: { ...context.tools, webdriverio: '' } },
      { ...context, tools: { ...context.tools, puppeteer: '' } },
      { ...context, tools: { ...context.tools, ffmpeg: '' } },
    ]) {
      expect(
        readManifestRunContext({
          [MANIFEST_RUN_CONFIG_KEY]: invalidContext,
        }),
      ).toBeUndefined()
    }
    expect(context.tools.node).toBe(process.version)
    expect(context.tools.service).not.toBe('unknown')
    expect(context.tools.webdriverio).not.toBe('unknown')
  })

  it('records media metadata, normalized paths, timings, and private session hash', async () => {
    const outputDir = await createTempDir()
    const artifactPath = path.join(outputDir, 'nested', 'recording.webm')
    await fs.mkdir(path.dirname(artifactPath), { recursive: true })
    await fs.writeFile(artifactPath, Buffer.alloc(64))
    const { context, recorder } = await createRecorder(outputDir)

    await recorder.beginEntity({
      test: {
        file: path.join(process.cwd(), 'tests', 'specs', 'manifest.spec.ts'),
        title: 'records metadata',
        fullTitle: 'manifest records metadata',
        fullName: 'manifest records metadata',
      },
      scope: 'test',
      specPaths: [],
    })
    expect(recorder.currentEntryId).toBeTypeOf('string')
    recorder.markCaptureStarted({ width: 640, height: 360 })
    recorder.updateProtocol('classic+cdp')
    await recorder.recordResult('passed')
    await recorder.noteFfmpegVersion('7.1.1')
    await recorder.completeCurrent({
      decision: 'recorded',
      result: 'passed',
      paths: [artifactPath, artifactPath],
      processingOutcome: 'completed',
      processingOperation: 'transcode',
    })
    expect(recorder.currentEntryId).toBeUndefined()
    await recorder.flush()

    const manifest = await aggregateManifestRun(context, 0)
    const entry = firstEntry(manifest)
    expect(isVideoManifest(manifest)).toBe(true)
    expect(firstRun(manifest).tools.ffmpeg).toBe('7.1.1')
    expect(entry).toMatchObject({
      cid: '0-0',
      framework: 'mocha',
      spec: 'tests/specs/manifest.spec.ts',
      test: {
        name: 'records metadata',
        fullName: 'manifest records metadata',
      },
      attempt: 1,
      result: 'passed',
      browser: {
        name: 'chrome',
        version: '140.0.0',
        protocol: 'classic+cdp',
      },
      capture: {
        decision: 'recorded',
        segments: [
          {
            path: 'nested/recording.webm',
            mimeType: 'video/webm',
            size: 64,
            width: 640,
            height: 360,
          },
        ],
        final: { path: 'nested/recording.webm' },
      },
      processing: {
        timing: 'after-test',
        outcome: 'completed',
        operation: 'transcode',
      },
    })
    expect(entry.sessionHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(entry.sessionHash).not.toContain('raw-private-session-id')
    expect(JSON.stringify(manifest)).not.toContain('raw-private-session-id')
    expect(entry.timings.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('preserves a checkpoint when a worker is killed before finalization', async () => {
    const outputDir = await createTempDir()
    const { context, recorder } = await createRecorder(outputDir)
    await recorder.beginEntity({
      test: { title: 'interrupted', file: 'specs/interrupted.ts' },
      scope: 'test',
      specPaths: [],
    })
    await recorder.flush()

    const manifest = await aggregateManifestRun(context, 1)
    expect(firstEntry(manifest)).toMatchObject({
      result: 'unknown',
      capture: {
        decision: 'failed',
        reason: 'worker-interrupted-before-finalization',
      },
      processing: { outcome: 'failed', operation: 'capture' },
    })
  })

  it('tracks retries and aggregates spec-scope failures across tests', async () => {
    const outputDir = await createTempDir()
    const { context, recorder } = await createRecorder(
      outputDir,
      '1-0',
      'jasmine',
    )
    const specInput = {
      test: { title: 'first', file: 'specs/shared.ts' },
      scope: 'spec' as const,
      specPaths: ['specs/shared.ts'],
    }
    const firstId = await recorder.beginEntity(specInput)
    recorder.setCurrentAttempt(3)
    await recorder.recordResult('passed')
    const sameId = await recorder.beginEntity({
      ...specInput,
      test: { title: 'second', file: 'specs/shared.ts' },
    })
    await recorder.recordResult('failed')
    await recorder.completeCurrent({
      decision: 'discarded',
      result: 'passed',
      reason: 'retention-policy',
      processingOutcome: 'skipped',
    })

    const manifest = await aggregateManifestRun(context, 1)
    const entry = firstEntry(manifest)
    expect(sameId).toBe(firstId)
    expect(entry.scope).toBe('spec')
    expect(entry.test).toBeUndefined()
    expect(entry.attempt).toBe(3)
    expect(entry.result).toBe('failed')
    expect(entry.capture.decision).toBe('discarded')
  })

  it('updates deferred processing outcomes and keeps a valid last snapshot', async () => {
    const outputDir = await createTempDir()
    const inputPath = path.join(outputDir, 'capture.webm')
    const outputPath = path.join(outputDir, 'capture.mp4')
    await fs.writeFile(inputPath, Buffer.alloc(12))
    await fs.writeFile(outputPath, Buffer.alloc(10))
    const { context, recorder } = await createRecorder(
      outputDir,
      '2-0',
      'cucumber',
    )
    const entryId = await recorder.beginEntity({
      test: { title: 'deferred', file: 'features/deferred.feature' },
      scope: 'test',
      specPaths: [],
      attempt: 2,
    })
    recorder.markCaptureStarted()
    await recorder.completeCurrent({
      decision: 'recorded',
      result: 'failed',
      paths: [inputPath],
      processingOutcome: 'pending',
      processingOperation: 'transcode',
    })
    await recorder.completeDeferred(entryId, {
      decision: 'recorded',
      paths: [outputPath],
      processingOutcome: 'completed',
      processingOperation: 'transcode',
    })
    await recorder.completeDeferred('missing-entry', {
      decision: 'failed',
      processingOutcome: 'failed',
    })
    await recorder.noteFfmpegVersion('   ')

    const manifest = await aggregateManifestRun(context, 0)
    const entry = firstEntry(manifest)
    expect(entry.attempt).toBe(2)
    expect(entry.capture.final).toMatchObject({
      path: 'capture.mp4',
      mimeType: 'video/mp4',
      size: 10,
    })
    expect(entry.processing).toMatchObject({
      timing: 'after-worker',
      outcome: 'completed',
    })
  })

  it('reuses existing deferred paths and tolerates missing media', async () => {
    const outputDir = await createTempDir()
    const { context, recorder } = await createRecorder(outputDir)
    const entryId = await recorder.beginEntity({
      test: { title: 'missing media', file: 'specs/missing.ts' },
      scope: 'test',
      specPaths: [],
    })
    await recorder.recordResult('skipped')
    await recorder.completeCurrent({
      decision: 'recorded',
      result: 'unknown',
      paths: [path.join(outputDir, 'missing.webm')],
      processingOutcome: 'pending',
    })
    await recorder.completeDeferred(entryId, {
      decision: 'recorded',
      processingOutcome: 'failed',
      reason: 'still-missing',
    })

    const manifest = await aggregateManifestRun(context, 0)
    expect(firstEntry(manifest)).toMatchObject({
      result: 'skipped',
      capture: {
        segments: [{ path: 'missing.webm', size: 0 }],
      },
      processing: { outcome: 'failed', reason: 'still-missing' },
    })
  })

  it('handles sparse WDIO metadata and no-op calls safely', async () => {
    const outputDir = await createTempDir()
    const context = await createManifestRunContext(outputDir)
    const recorder = new ManifestWorkerRecorder({
      context,
      cid: '0-0',
      framework: 'unknown',
    })
    recorder.configureSession({
      sessionId: 'session',
      protocol: 'unsupported',
    })
    const firstId = await recorder.beginEntity({
      scope: 'test',
      specPaths: [],
    })
    recorder.markCaptureStarted()
    recorder.markCaptureStarted()
    recorder.setCurrentAttempt(0)
    await recorder.completeCurrent({
      decision: 'skipped',
      result: 'unknown',
    })
    await recorder.recordResult('passed')
    recorder.markCaptureStarted({ width: 1, height: 1 })
    recorder.setCurrentAttempt(4)
    await expect(
      recorder.completeCurrent({ decision: 'failed', result: 'failed' }),
    ).resolves.toBeUndefined()
    await new ManifestWorkerRecorder({
      context,
      cid: '',
      framework: 'unknown',
    }).recordResult('unknown')
    await recorder.completeDeferred(firstId, { decision: 'recorded' })

    await recorder.beginEntity({
      test: { title: '', fullTitle: '', fullName: 'fallback name' },
      scope: 'test',
      specPaths: ['specs/fallback.ts'],
    })
    await recorder.completeCurrent({
      decision: 'skipped',
      result: 'skipped',
    })
    const journals = await fs.readdir(journalDir(outputDir, context.runId))
    const workerJournal = path.join(
      journalDir(outputDir, context.runId),
      firstString(journals.filter((name) => name.endsWith('.jsonl'))),
    )
    const checkpoint = JSON.parse(
      firstString((await fs.readFile(workerJournal, 'utf8')).split('\n')),
    ) as { entry: { runId: string } }
    checkpoint.entry.runId = 'another-run'
    await fs.appendFile(
      workerJournal,
      `${JSON.stringify(checkpoint)}\n`,
      'utf8',
    )
    await fs.writeFile(
      path.join(journalDir(outputDir, context.runId), 'README.txt'),
      'ignored',
      'utf8',
    )

    const manifest = await aggregateManifestRun(context, 0)
    const run = firstRun(manifest)
    expect(run.entries).toHaveLength(2)
    expect(run.entries[0]).toMatchObject({
      cid: '0-0',
      attempt: 1,
      result: 'passed',
      browser: { name: 'unknown' },
      test: { name: 'unknown test' },
    })
    expect(run.entries[1]?.test).toMatchObject({
      name: 'fallback name',
      fullName: 'fallback name',
    })
    expect(run.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'invalid-journal-entry' }),
    )
  })

  it('aggregates parallel worker journals and ignores a malformed final line', async () => {
    const outputDir = await createTempDir()
    const context = await createManifestRunContext(outputDir)
    const recorders = ['0-0', '0-1'].map(
      (cid) => new ManifestWorkerRecorder({ context, cid, framework: 'mocha' }),
    )
    await Promise.all(
      recorders.map(async (recorder, index) => {
        await recorder.beginEntity({
          test: {
            title: `parallel ${index.toString()}`,
            file: `specs/${index.toString()}.ts`,
          },
          scope: 'test',
          specPaths: [],
        })
        await recorder.completeCurrent({
          decision: 'skipped',
          result: 'skipped',
          reason: 'filtered',
          processingOutcome: 'skipped',
        })
      }),
    )
    const journals = await fs.readdir(journalDir(outputDir, context.runId))
    await fs.appendFile(
      path.join(journalDir(outputDir, context.runId), firstString(journals)),
      '{"type":"entry"',
      'utf8',
    )

    const manifest = await aggregateManifestRun(context, 0)
    expect(firstRun(manifest).entries).toHaveLength(2)
    expect(firstRun(manifest).diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'malformed-final-journal-line',
        line: 3,
      }),
    )
  })

  it('reports invalid non-final journal events while retaining later entries', async () => {
    const outputDir = await createTempDir()
    const { context, recorder } = await createRecorder(outputDir)
    await recorder.beginEntity({
      test: { title: 'valid', file: 'specs/valid.ts' },
      scope: 'test',
      specPaths: [],
    })
    await recorder.completeCurrent({
      decision: 'skipped',
      result: 'skipped',
      reason: 'filtered',
      processingOutcome: 'skipped',
    })
    const journals = await fs.readdir(journalDir(outputDir, context.runId))
    const journalPath = path.join(
      journalDir(outputDir, context.runId),
      firstString(journals),
    )
    const content = await fs.readFile(journalPath, 'utf8')
    await fs.writeFile(
      journalPath,
      `null\n${content}{"type":"unknown"}\n`,
      'utf8',
    )

    const manifest = await aggregateManifestRun(context, 0)
    expect(firstRun(manifest).entries).toHaveLength(1)
    expect(firstRun(manifest).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid-journal-entry', line: 1 }),
        expect.objectContaining({ code: 'malformed-final-journal-line' }),
      ]),
    )
  })

  it('serializes concurrent launchers into distinct run records', async () => {
    const outputDir = await createTempDir()
    const first = await createManifestRunContext(outputDir)
    const second = await createManifestRunContext(outputDir)
    await Promise.all([
      aggregateManifestRun(first, 0),
      aggregateManifestRun(second, 1),
    ])

    const manifest = JSON.parse(
      await fs.readFile(path.join(outputDir, 'manifest.json'), 'utf8'),
    ) as unknown
    expect(isVideoManifest(manifest)).toBe(true)
    expect(
      (manifest as { runs: { id: string }[] }).runs.map((run) => run.id),
    ).toEqual(expect.arrayContaining([first.runId, second.runId]))
  })

  it('does not remove a replacement manifest lock during release', async () => {
    const outputDir = await createTempDir()
    const context = await createManifestRunContext(outputDir)
    const lockPath = path.join(outputDir, '.wdio-video-manifest.lock')
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (oldPath, newPath) => {
      writeFileSync(
        lockPath,
        JSON.stringify({
          createdAt: Date.now(),
          ownerId: 'replacement-owner',
          pid: process.pid,
        }),
        'utf8',
      )
      await rename(oldPath, newPath)
    })

    await aggregateManifestRun(context, 0)

    await expect(fs.readFile(lockPath, 'utf8')).resolves.toContain(
      'replacement-owner',
    )
  })

  it('aggregates an empty run after its journal directory is lost', async () => {
    const outputDir = await createTempDir()
    const context = await createManifestRunContext(outputDir)
    await fs.rm(journalDir(outputDir, context.runId), {
      recursive: true,
      force: true,
    })
    const manifest = await aggregateManifestRun(context, 0)
    expect(firstRun(manifest).entries).toEqual([])
  })

  it('waits for a live manifest lock to be released', async () => {
    const outputDir = await createTempDir()
    const context = await createManifestRunContext(outputDir)
    const lockPath = path.join(outputDir, '.wdio-video-manifest.lock')
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        createdAt: Date.now() - 300_000,
      }),
      'utf8',
    )
    const releaseTimer = setTimeout(() => {
      void fs.unlink(lockPath)
    }, 50)
    try {
      const manifest = await aggregateManifestRun(context, 0)
      expect(firstRun(manifest).id).toBe(context.runId)
    } finally {
      clearTimeout(releaseTimer)
    }
  })

  it('recovers a stale lock and refuses to overwrite an invalid manifest', async () => {
    const outputDir = await createTempDir()
    const context = await createManifestRunContext(outputDir)
    const staleLockPath = path.join(outputDir, '.wdio-video-manifest.lock')
    await fs.writeFile(staleLockPath, '{invalid', 'utf8')
    const staleTime = new Date(Date.now() - 300_000)
    await fs.utimes(staleLockPath, staleTime, staleTime)
    await aggregateManifestRun(context, 0)
    expect(
      await fs
        .stat(path.join(outputDir, '.wdio-video-manifest.lock'))
        .catch(() => undefined),
    ).toBeUndefined()

    const next = await createManifestRunContext(outputDir)
    await fs.writeFile(path.join(outputDir, 'manifest.json'), '{}', 'utf8')
    await expect(aggregateManifestRun(next, 0)).rejects.toThrow(
      'Existing manifest.json is invalid',
    )
    expect(
      await fs
        .stat(path.join(outputDir, '.wdio-video-manifest.lock'))
        .catch(() => undefined),
    ).toBeUndefined()
  })

  it('normalizes paths and hashes private values deterministically', async () => {
    const outputDir = await createTempDir()
    const nested = path.join(outputDir, 'nested', 'artifact.webm')
    const outside = path.join(path.dirname(outputDir), 'secret.webm')

    expect(normalizeManifestPath(nested, outputDir)).toBe(
      'nested/artifact.webm',
    )
    expect(normalizeManifestPath(pathToFileURL(nested).href, outputDir)).toBe(
      'nested/artifact.webm',
    )
    expect(
      normalizeManifestPath(
        path.join(outputDir, 'nested', `\u0001artifact.webm`),
        outputDir,
      ),
    ).toBe('nested/_artifact.webm')
    expect(normalizeManifestPath(outside, outputDir)).toBe('secret.webm')
    expect(normalizeManifestPath(outputDir, outputDir)).toBe(
      path.basename(outputDir),
    )
    expect(normalizeManifestPath(path.parse(outputDir).root, outputDir)).toBe(
      'unknown',
    )
    expect(hashPrivateValue('run', 'session')).toBe(
      hashPrivateValue('run', 'session'),
    )
    expect(hashPrivateValue('run', 'session')).not.toBe(
      hashPrivateValue('other-run', 'session'),
    )
  })

  it.each([
    ['mocha', 'mocha'],
    ['jasmine', 'jasmine'],
    ['cucumber', 'cucumber'],
    ['tap', 'unknown'],
    [undefined, 'unknown'],
  ] as const)('normalizes framework %s to %s', (input, expected) => {
    expect(normalizeManifestFramework(input)).toBe(expected)
  })
})
