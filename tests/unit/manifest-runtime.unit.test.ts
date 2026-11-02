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
import { nodeFileSystem, systemClock } from '../../src/service/boundaries.js'
import type { SegmentTab } from '../../src/service/capture-session.js'
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
import type { MediaDimensions } from '../../src/service/media-metadata.js'

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
  const readDimensions = vi.fn(
    async (_filePath: string): Promise<MediaDimensions | undefined> =>
      undefined,
  )
  const recorder = new ManifestWorkerRecorder({
    context,
    cid,
    framework,
    readDimensions,
  })
  recorder.configureSession({
    sessionId: 'raw-private-session-id',
    browserName: 'chrome',
    browserVersion: '140.0.0',
    protocol: 'bidi+cdp',
  })
  return { context, recorder, readDimensions }
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
  it.each(['', '..', '../escape', 'nested/run', 'C:\\escape', 'run.'])(
    'rejects unsafe manifest run ID %j before creating directories',
    async (runId) => {
      const outputDir = await createTempDir()
      const mkdir = vi.spyOn(fs, 'mkdir')
      await expect(createManifestRunContext(outputDir, runId)).rejects.toThrow(
        'unsafe',
      )
      expect(mkdir).not.toHaveBeenCalled()
      expect(await fs.readdir(outputDir)).toEqual([])
    },
  )

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
    const { context, recorder, readDimensions } =
      await createRecorder(outputDir)
    readDimensions.mockResolvedValue({ width: 640, height: 360 })

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
    recorder.markCaptureStarted()
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
    expect(readDimensions).toHaveBeenCalledExactlyOnceWith(artifactPath)
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

  it.each(['relative', 'absolute'] as const)(
    'resolves %s filesystem paths without duplicating outputDir, including deferred reuse',
    async (pathStyle) => {
      const outputDir = await createTempDir()
      const artifactPath = path.join(outputDir, 'nested', 'recording.webm')
      await fs.mkdir(path.dirname(artifactPath), { recursive: true })
      await fs.writeFile(artifactPath, 'retained-media')
      const { context, recorder, readDimensions } =
        await createRecorder(outputDir)
      const filePath =
        pathStyle === 'relative'
          ? path.relative(process.cwd(), artifactPath)
          : artifactPath
      const entryId = await recorder.beginEntity({
        scope: 'test',
        specPaths: ['consumer.ts'],
      })
      await recorder.completeCurrent({
        decision: 'recorded',
        result: 'failed',
        paths: [filePath],
        processingOutcome: 'pending',
      })
      const pending = firstEntry(await aggregateManifestRun(context, 0))
      expect(pending.capture.segments).toEqual([
        { path: 'nested/recording.webm', size: 14, mimeType: 'video/webm' },
      ])
      readDimensions.mockResolvedValue({ width: 800, height: 600 })
      await recorder.completeDeferred(entryId, { decision: 'recorded' })
      expect(readDimensions).toHaveBeenCalledExactlyOnceWith(artifactPath)
      expect(
        firstEntry(await aggregateManifestRun(context, 0)).capture.final,
      ).toEqual({
        path: 'nested/recording.webm',
        size: 14,
        mimeType: 'video/webm',
        width: 800,
        height: 600,
      })
    },
  )

  it('measures distinct retained segments independently and omits unavailable metadata', async () => {
    const outputDir = await createTempDir()
    const { context, recorder, readDimensions } =
      await createRecorder(outputDir)
    const files = [
      'first.webm',
      'second.mp4',
      'unknown.webm',
      'empty.webm',
      'missing.webm',
    ]
    await Promise.all(
      files
        .slice(0, 4)
        .map((file) =>
          fs.writeFile(
            path.join(outputDir, file),
            file === 'empty.webm' ? '' : 'media',
          ),
        ),
    )
    readDimensions.mockImplementation(async (file) => {
      if (file.endsWith('first.webm')) {
        return { width: 801, height: 401 }
      }
      if (file.endsWith('second.mp4')) {
        return { width: 402, height: 202 }
      }
      return undefined
    })
    await recorder.beginEntity({ scope: 'test', specPaths: ['test.ts'] })
    await recorder.completeCurrent({
      decision: 'recorded',
      result: 'failed',
      paths: files.map((file) => path.join(outputDir, file)),
    })

    const entry = firstEntry(await aggregateManifestRun(context, 0))
    expect(readDimensions).toHaveBeenCalledTimes(3)
    expect(entry.capture.final).toBeUndefined()
    expect(entry.capture.segments).toEqual([
      {
        path: 'first.webm',
        mimeType: 'video/webm',
        size: 5,
        width: 801,
        height: 401,
      },
      {
        path: 'second.mp4',
        mimeType: 'video/mp4',
        size: 5,
        width: 402,
        height: 202,
      },
      { path: 'unknown.webm', mimeType: 'video/webm', size: 5 },
      { path: 'empty.webm', mimeType: 'video/webm', size: 0 },
      { path: 'missing.webm', mimeType: 'video/webm', size: 0 },
    ])
  })

  it('probes only finalized deferred media, not pending or discarded recordings', async () => {
    const outputDir = await createTempDir()
    const { context, recorder, readDimensions } =
      await createRecorder(outputDir)
    await fs.writeFile(path.join(outputDir, 'input.webm'), 'source')
    await fs.writeFile(path.join(outputDir, 'final.mp4'), 'output')
    const entryId = await recorder.beginEntity({
      scope: 'test',
      specPaths: ['deferred.ts'],
    })
    await recorder.completeCurrent({
      decision: 'recorded',
      result: 'failed',
      paths: [path.join(outputDir, 'input.webm')],
      processingOutcome: 'pending',
    })
    expect(readDimensions).not.toHaveBeenCalled()
    const pending = firstEntry(await aggregateManifestRun(context, 0))
    expect(pending.capture.segments[0]).not.toHaveProperty('width')
    expect(pending.capture.final).toBeUndefined()

    readDimensions.mockResolvedValue({ width: 802, height: 402 })
    await recorder.completeDeferred(entryId, {
      decision: 'recorded',
      paths: [path.join(outputDir, 'final.mp4')],
      processingOutcome: 'completed',
    })
    expect(readDimensions).toHaveBeenCalledExactlyOnceWith(
      path.join(outputDir, 'final.mp4'),
    )
    const completed = firstEntry(await aggregateManifestRun(context, 0))
    expect(completed.capture.final).toMatchObject({
      path: 'final.mp4',
      width: 802,
      height: 402,
    })

    await recorder.beginEntity({ scope: 'test', specPaths: ['discarded.ts'] })
    await recorder.completeCurrent({
      decision: 'discarded',
      result: 'passed',
      paths: [],
    })
    expect(readDimensions).toHaveBeenCalledOnce()
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
    recorder.markCaptureStarted()
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

  it('does not replace journal enumeration failures with an empty run', async () => {
    const outputDir = await createTempDir()
    const context = await createManifestRunContext(outputDir)
    const journalDirectory = journalDir(outputDir, context.runId)
    await fs.rm(journalDirectory, { recursive: true, force: true })
    await fs.writeFile(journalDirectory, 'not-a-directory', 'utf8')

    await expect(aggregateManifestRun(context, 0)).rejects.toMatchObject({
      code: expect.stringMatching(/^(EACCES|ENOTDIR|EPERM)$/u),
    })
    await expect(
      fs.stat(path.join(outputDir, 'manifest.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('tracks same-title tests in different suites as independent attempts', async () => {
    const outputDir = await createTempDir()
    const { context, recorder } = await createRecorder(outputDir)
    for (const fullTitle of [
      'first suite same title',
      'second suite same title',
    ]) {
      await recorder.beginEntity({
        test: {
          title: 'same title',
          fullTitle,
          file: 'specs/same-title.ts',
        },
        scope: 'test',
        specPaths: [],
      })
      await recorder.completeCurrent({
        decision: 'skipped',
        result: 'skipped',
        processingOutcome: 'skipped',
      })
    }

    const manifest = await aggregateManifestRun(context, 0)
    expect(firstRun(manifest).entries.map((entry) => entry.attempt)).toEqual([
      1, 1,
    ])
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
    // Release between acquisition attempts, not concurrently with Windows I/O.
    // Await the release so failures belong to this test, not an unhandled timer.
    const delay = vi
      .spyOn(systemClock, 'delay')
      .mockImplementationOnce(async () => {
        const owner = JSON.parse(await fs.readFile(lockPath, 'utf8')) as {
          pid: number
        }
        expect(owner.pid).toBe(process.pid)
        await fs.unlink(lockPath)
      })
    const manifest = await aggregateManifestRun(context, 0)
    expect(firstRun(manifest).id).toBe(context.runId)
    expect(delay).toHaveBeenCalledOnce()
  })

  it.each(['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'EPERM'])(
    'polls through a transient %s while opening the manifest lock',
    async (code) => {
      if (code === 'EPERM' && process.platform !== 'win32') {
        // A sharing violation is a Windows condition; EPERM is permanent here.
        return
      }
      const outputDir = await createTempDir()
      const context = await createManifestRunContext(outputDir)
      const openExclusive = vi
        .spyOn(nodeFileSystem, 'openExclusive')
        .mockRejectedValueOnce(
          Object.assign(new Error(`${code}: refused`), { code }),
        )

      const manifest = await aggregateManifestRun(context, 0)

      expect(firstRun(manifest).id).toBe(context.runId)
      expect(openExclusive.mock.calls.length).toBeGreaterThan(1)
      await expect(
        fs.stat(path.join(outputDir, '.wdio-video-manifest.lock')),
      ).rejects.toThrow()
    },
  )

  it.each(['EACCES', 'ENOSPC', 'EROFS'])(
    'fails closed on a %s manifest lock failure instead of polling',
    async (code) => {
      const outputDir = await createTempDir()
      const context = await createManifestRunContext(outputDir)
      const failure = Object.assign(new Error(`${code}: refused`), { code })
      vi.spyOn(nodeFileSystem, 'openExclusive').mockRejectedValue(failure)
      const delay = vi.spyOn(systemClock, 'delay')

      await expect(aggregateManifestRun(context, 0)).rejects.toMatchObject({
        cause: failure,
      })
      expect(delay).not.toHaveBeenCalled()
      await expect(
        fs.stat(path.join(outputDir, 'manifest.json')),
      ).rejects.toThrow()
    },
  )

  it('reports the last transient failure when the lock deadline expires', async () => {
    const outputDir = await createTempDir()
    const context = await createManifestRunContext(outputDir)
    const failure = Object.assign(new Error('EBUSY: refused'), {
      code: 'EBUSY',
    })
    vi.spyOn(nodeFileSystem, 'openExclusive').mockRejectedValue(failure)
    let elapsed = 0
    vi.spyOn(systemClock, 'now').mockImplementation(() => elapsed)
    vi.spyOn(systemClock, 'delay').mockImplementation(async () => {
      elapsed += 30_000
    })

    await expect(aggregateManifestRun(context, 0)).rejects.toMatchObject({
      cause: { cause: failure },
      message: expect.stringContaining(
        'repeated transient filesystem failures',
      ),
    })
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

describe('skipped entities written whole', () => {
  it('keeps overlapping skipped entries apart from the current entity', async () => {
    const outputDir = await createTempDir()
    const { context, recorder } = await createRecorder(outputDir)
    const current = await recorder.beginEntity({
      scope: 'test',
      specPaths: ['parallel.ts'],
      test: { title: 'a sequential test' },
    })

    const ids = await Promise.all(
      ['first', 'second'].map((title) =>
        recorder.recordSkippedEntity(
          { scope: 'test', specPaths: ['parallel.ts'], test: { title } },
          { reason: 'parallel-mode', result: 'unknown' },
        ),
      ),
    )
    await recorder.flush()

    expect(recorder.currentEntryId).toBe(current)
    const entries = firstRun(await aggregateManifestRun(context, 0)).entries
    const skipped = entries.filter((entry) => ids.includes(entry.id))
    expect(
      skipped.map((entry) => [
        entry.test?.name,
        entry.capture.decision,
        entry.capture.reason,
        entry.processing.outcome,
      ]),
    ).toEqual([
      ['first', 'skipped', 'parallel-mode', 'skipped'],
      ['second', 'skipped', 'parallel-mode', 'skipped'],
    ])
  })
})

describe('manifest tab provenance', () => {
  const tabA: SegmentTab = {
    contextId: 'raw-tab-a',
    ordinal: 1,
    reason: 'start',
  }
  const tabB: SegmentTab = {
    contextId: 'raw-tab-b',
    ordinal: 2,
    reason: 'command',
  }

  const writeMedia = async (
    outputDir: string,
    names: string[],
  ): Promise<string[]> => {
    return Promise.all(
      names.map(async (name) => {
        const filePath = path.join(outputDir, name)
        await fs.writeFile(filePath, Buffer.alloc(8))
        return filePath
      }),
    )
  }

  it('records each segment’s tab with a hashed tab identity', async () => {
    const outputDir = await createTempDir()
    const { context, recorder } = await createRecorder(outputDir)
    const paths = await writeMedia(outputDir, ['t_part1.webm', 't_part2.webm'])
    await recorder.beginEntity({ scope: 'test', specPaths: ['tabs.ts'] })
    await recorder.completeCurrent({
      decision: 'recorded',
      result: 'passed',
      paths,
      tabs: new Map([
        [1, tabA],
        [2, tabB],
      ]),
    })
    await recorder.flush()

    const manifest = await aggregateManifestRun(context, 0)
    const { capture } = firstEntry(manifest)
    expect(isVideoManifest(manifest)).toBe(true)
    expect(capture.segments.map((segment) => segment.tab)).toEqual([
      {
        ordinal: 1,
        reason: 'start',
        contextHash: hashPrivateValue(context.runId, 'raw-tab-a'),
      },
      {
        ordinal: 2,
        reason: 'command',
        contextHash: hashPrivateValue(context.runId, 'raw-tab-b'),
      },
    ])
    expect(capture.final).toBeUndefined()
    expect(JSON.stringify(manifest)).not.toContain('raw-tab')
  })

  it('lists the tabs of a merged file in part order', async () => {
    const outputDir = await createTempDir()
    const { context, recorder } = await createRecorder(outputDir)
    const [merged] = await writeMedia(outputDir, ['t.webm'])
    await recorder.beginEntity({ scope: 'test', specPaths: ['tabs.ts'] })
    await recorder.completeCurrent({
      decision: 'recorded',
      result: 'passed',
      paths: [merged ?? ''],
      tabs: new Map([
        [2, tabB],
        [1, tabA],
      ]),
    })
    await recorder.flush()

    const { capture } = firstEntry(await aggregateManifestRun(context, 0))
    expect(capture.segments[0]?.tab).toBeUndefined()
    expect(capture.segments[0]?.tabs).toEqual(capture.final?.tabs)
    expect(capture.final?.tabs?.map((tab) => tab.ordinal)).toEqual([1, 2])
  })

  it('lists the tabs on a merged file kept beside its parts', async () => {
    const outputDir = await createTempDir()
    const { context, recorder } = await createRecorder(outputDir)
    const paths = await writeMedia(outputDir, [
      't_part1.webm',
      't_part2.webm',
      't.webm',
    ])
    await recorder.beginEntity({ scope: 'test', specPaths: ['tabs.ts'] })
    await recorder.completeCurrent({
      decision: 'recorded',
      result: 'passed',
      paths,
      tabs: new Map([
        [1, tabA],
        [2, tabB],
      ]),
    })
    await recorder.flush()

    const manifest = await aggregateManifestRun(context, 0)
    const { capture } = firstEntry(manifest)
    expect(isVideoManifest(manifest)).toBe(true)
    expect(
      capture.segments.map((segment) => [
        segment.path,
        segment.tab?.ordinal,
        segment.tabs?.map((tab) => tab.ordinal),
      ]),
    ).toEqual([
      ['t_part1.webm', 1, undefined],
      ['t_part2.webm', 2, undefined],
      ['t.webm', undefined, [1, 2]],
    ])
    expect(capture.final).toBeUndefined()
  })

  it('keeps a merged file’s tabs when it is transcoded later', async () => {
    const outputDir = await createTempDir()
    const { context, recorder } = await createRecorder(outputDir)
    const [part1, part2, merged, mergedMp4] = await writeMedia(outputDir, [
      't_part1.webm',
      't_part2.webm',
      't.webm',
      't.mp4',
    ])
    const entryId = await recorder.beginEntity({
      scope: 'test',
      specPaths: ['tabs.ts'],
    })
    await recorder.completeCurrent({
      decision: 'recorded',
      result: 'passed',
      paths: [part1 ?? '', part2 ?? ''],
      processingOutcome: 'pending',
      tabs: new Map([
        [1, tabA],
        [2, tabB],
      ]),
    })
    for (const output of [merged, mergedMp4]) {
      await recorder.completeDeferred(entryId, {
        decision: 'recorded',
        paths: [output ?? ''],
        processingOutcome: 'completed',
      })
    }
    await recorder.flush()

    const { capture } = firstEntry(await aggregateManifestRun(context, 0))
    expect(capture.segments.map((segment) => segment.path)).toEqual(['t.mp4'])
    expect(capture.final?.tabs?.map((tab) => tab.ordinal)).toEqual([1, 2])
  })

  it('gives a single-segment final file that segment’s tab', async () => {
    const outputDir = await createTempDir()
    const { context, recorder } = await createRecorder(outputDir)
    const paths = await writeMedia(outputDir, ['t_part3.webm'])
    await recorder.beginEntity({ scope: 'test', specPaths: ['tabs.ts'] })
    await recorder.completeCurrent({
      decision: 'recorded',
      result: 'passed',
      paths,
      tabs: new Map([[3, tabB]]),
    })
    await recorder.flush()

    const { capture } = firstEntry(await aggregateManifestRun(context, 0))
    expect(capture.segments[0]?.tab?.ordinal).toBe(2)
    expect(capture.final).not.toHaveProperty('tab')
    expect(capture.final?.tabs).toEqual([capture.segments[0]?.tab])
  })

  it('keeps the tabs through a deferred merge', async () => {
    const outputDir = await createTempDir()
    const { context, recorder } = await createRecorder(outputDir)
    const paths = await writeMedia(outputDir, [
      't_part1.webm',
      't_part2.webm',
      't.webm',
    ])
    const entryId = await recorder.beginEntity({
      scope: 'test',
      specPaths: ['tabs.ts'],
    })
    await recorder.completeCurrent({
      decision: 'recorded',
      result: 'passed',
      paths: paths.slice(0, 2),
      processingOutcome: 'pending',
      tabs: new Map([
        [1, tabA],
        [2, tabB],
      ]),
    })
    await recorder.completeDeferred(entryId, {
      decision: 'recorded',
      paths: paths.slice(2),
      processingOutcome: 'completed',
      processingOperation: 'merge',
    })
    await recorder.flush()

    const { capture } = firstEntry(await aggregateManifestRun(context, 0))
    expect(capture.segments.map((segment) => segment.path)).toEqual(['t.webm'])
    expect(capture.final?.tabs?.map((tab) => tab.reason)).toEqual([
      'start',
      'command',
    ])
  })

  it.each([
    { firstFails: false, partOneFirst: true },
    { firstFails: false, partOneFirst: false },
    { firstFails: true, partOneFirst: true },
    { firstFails: true, partOneFirst: false },
  ])(
    'keeps both results when completions overlap (part 1 fails: $firstFails, part 1 first: $partOneFirst)',
    async ({ firstFails, partOneFirst }) => {
      const outputDir = await createTempDir()
      const { context, recorder, readDimensions } =
        await createRecorder(outputDir)
      const [part1, part2, part1Mp4, part2Mp4] = await writeMedia(outputDir, [
        't_part1.webm',
        't_part2.webm',
        't_part1.mp4',
        't_part2.mp4',
      ])
      const entered = [
        Promise.withResolvers<void>(),
        Promise.withResolvers<void>(),
      ]
      const released = [
        Promise.withResolvers<void>(),
        Promise.withResolvers<void>(),
      ]
      readDimensions.mockImplementation(async (filePath) => {
        const index = filePath.includes('_part1.') ? 0 : 1
        entered[index]?.resolve()
        await released[index]?.promise
        return undefined
      })
      const entryId = await recorder.beginEntity({
        scope: 'test',
        specPaths: ['tabs.ts'],
      })
      await recorder.completeCurrent({
        decision: 'recorded',
        result: 'passed',
        paths: [part1 ?? '', part2 ?? ''],
        processingOutcome: 'pending',
        processingOperation: 'transcode',
        tabs: new Map([
          [1, tabA],
          [2, tabB],
        ]),
      })
      recorder.expectDeferredTasks(entryId, 2)

      const completions = [
        recorder.completeDeferred(entryId, {
          decision: firstFails ? 'failed' : 'recorded',
          paths: [firstFails ? (part1 ?? '') : (part1Mp4 ?? '')],
          replaces: [part1 ?? ''],
          processingOutcome: firstFails ? 'failed' : 'completed',
          processingOperation: 'transcode',
          ...(firstFails ? { reason: 'part-one-failed' } : {}),
        }),
        recorder.completeDeferred(entryId, {
          decision: 'recorded',
          paths: [part2Mp4 ?? ''],
          replaces: [part2 ?? ''],
          processingOutcome: 'completed',
          processingOperation: 'transcode',
        }),
      ]
      // Both hold the pending entry before either publishes.
      await Promise.all(entered.map((gate) => gate.promise))
      for (const index of partOneFirst ? [0, 1] : [1, 0]) {
        released[index]?.resolve()
        await completions[index]
      }
      await recorder.flush()

      const { capture, processing } = firstEntry(
        await aggregateManifestRun(context, 0),
      )
      expect(
        capture.segments.map((segment) => [segment.path, segment.tab?.ordinal]),
      ).toEqual([
        [firstFails ? 't_part1.webm' : 't_part1.mp4', 1],
        ['t_part2.mp4', 2],
      ])
      expect(capture.decision).toBe(firstFails ? 'failed' : 'recorded')
      expect(processing.outcome).toBe(firstFails ? 'failed' : 'completed')
      expect(processing.reason).toBe(firstFails ? 'part-one-failed' : undefined)
    },
  )

  it('stays pending until every deferred task of the entry completes', async () => {
    const outputDir = await createTempDir()
    const { context, recorder } = await createRecorder(outputDir)
    const [part1, part2, part1Mp4, part2Mp4] = await writeMedia(outputDir, [
      't_part1.webm',
      't_part2.webm',
      't_part1.mp4',
      't_part2.mp4',
    ])
    const entryId = await recorder.beginEntity({
      scope: 'test',
      specPaths: ['tabs.ts'],
    })
    await recorder.completeCurrent({
      decision: 'recorded',
      result: 'passed',
      paths: [part1 ?? '', part2 ?? ''],
      processingOutcome: 'pending',
      processingOperation: 'transcode',
    })
    recorder.expectDeferredTasks(entryId, 2)
    recorder.expectDeferredTasks('unknown-entry', 1)

    await recorder.completeDeferred(entryId, {
      decision: 'recorded',
      paths: [part1Mp4 ?? ''],
      replaces: [part1 ?? ''],
      processingOutcome: 'completed',
      processingOperation: 'transcode',
    })
    await recorder.flush()
    // A worker stopped here leaves an entry that does not claim completion.
    const interrupted = firstEntry(await aggregateManifestRun(context, 0))
    expect(interrupted.processing.outcome).toBe('pending')
    expect(interrupted.capture.segments.map((segment) => segment.path)).toEqual(
      ['t_part1.mp4', 't_part2.webm'],
    )

    await recorder.completeDeferred(entryId, {
      decision: 'recorded',
      paths: [part2Mp4 ?? ''],
      replaces: [part2 ?? ''],
      processingOutcome: 'completed',
      processingOperation: 'transcode',
    })
    await recorder.flush()
    const completed = firstEntry(await aggregateManifestRun(context, 0))
    expect(completed.processing.outcome).toBe('completed')
  })

  it('keeps every segment when each finishes deferred processing separately', async () => {
    const outputDir = await createTempDir()
    const { context, recorder } = await createRecorder(outputDir)
    const [part1, part2, part2Mp4, extra] = await writeMedia(outputDir, [
      't_part1.webm',
      't_part2.webm',
      't_part2.mp4',
      'extra.webm',
    ])
    const entryId = await recorder.beginEntity({
      scope: 'test',
      specPaths: ['tabs.ts'],
    })
    await recorder.completeCurrent({
      decision: 'recorded',
      result: 'passed',
      paths: [part1 ?? '', part2 ?? ''],
      processingOutcome: 'pending',
      processingOperation: 'transcode',
      tabs: new Map([
        [1, tabA],
        [2, tabB],
      ]),
    })
    await recorder.completeDeferred(entryId, {
      decision: 'recorded',
      paths: [part1 ?? ''],
      replaces: [part1 ?? ''],
      reason: 'deferred-transcode-failed-original-preserved',
      processingOutcome: 'failed',
      processingOperation: 'transcode',
    })
    await recorder.completeDeferred(entryId, {
      decision: 'recorded',
      paths: [part2Mp4 ?? ''],
      replaces: [part2 ?? ''],
      processingOutcome: 'completed',
      processingOperation: 'transcode',
    })
    await recorder.flush()

    const { capture, processing } = firstEntry(
      await aggregateManifestRun(context, 0),
    )
    expect(
      capture.segments.map((segment) => [segment.path, segment.tab?.ordinal]),
    ).toEqual([
      ['t_part1.webm', 1],
      ['t_part2.mp4', 2],
    ])
    expect(capture.final).toBeUndefined()
    expect(capture.reason).toBe('deferred-transcode-failed-original-preserved')
    expect(processing).toMatchObject({
      outcome: 'failed',
      operation: 'transcode',
      reason: 'deferred-transcode-failed-original-preserved',
    })

    // A result for a path the entry never listed is added after the others.
    await recorder.completeDeferred(entryId, {
      decision: 'recorded',
      paths: [extra ?? ''],
      replaces: [path.join(outputDir, 'unlisted.webm')],
      processingOutcome: 'completed',
    })
    await recorder.flush()
    const latest = firstEntry(await aggregateManifestRun(context, 0))
    expect(latest.capture.segments.map((segment) => segment.path)).toEqual([
      't_part1.webm',
      't_part2.mp4',
      'extra.webm',
    ])
  })
})
