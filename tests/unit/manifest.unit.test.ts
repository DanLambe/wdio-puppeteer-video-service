import { describe, expect, it } from 'vitest'
import {
  isVideoManifest,
  MANIFEST_SCHEMA_VERSION,
  type VideoManifestV1,
  validateVideoManifest,
} from '../../src/manifest.js'

const createManifest = (): VideoManifestV1 => ({
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  generatedAt: '2026-07-18T12:00:00.000Z',
  runs: [
    {
      id: 'run-1',
      startedAt: '2026-07-18T11:59:00.000Z',
      completedAt: '2026-07-18T12:00:00.000Z',
      exitCode: 0,
      tools: {
        service: '1.0.0',
        node: 'v24.15.0',
        webdriverio: '9.29.1',
        puppeteer: '25.3.0',
        ffmpeg: '7.1.1',
      },
      entries: [
        {
          id: 'entry-1',
          runId: 'run-1',
          cid: '0-0',
          sessionHash: 'hash',
          browser: {
            name: 'chrome',
            version: '140.0.0',
            protocol: 'bidi+cdp',
          },
          framework: 'mocha',
          spec: 'tests/example.spec.ts',
          test: { name: 'records', fullName: 'manifest records' },
          scope: 'test',
          attempt: 1,
          result: 'passed',
          capture: {
            decision: 'recorded',
            segments: [
              {
                path: 'recording.webm',
                mimeType: 'video/webm',
                size: 42,
                width: 1280,
                height: 720,
              },
            ],
            final: {
              path: 'recording.mp4',
              mimeType: 'video/mp4',
              size: 40,
              width: 1280,
              height: 720,
            },
          },
          processing: {
            timing: 'after-test',
            outcome: 'completed',
            operation: 'transcode',
            reason: 'converted',
          },
          timings: {
            startedAt: '2026-07-18T11:59:10.000Z',
            captureStartedAt: '2026-07-18T11:59:11.000Z',
            captureStoppedAt: '2026-07-18T11:59:12.000Z',
            processingStartedAt: '2026-07-18T11:59:13.000Z',
            completedAt: '2026-07-18T11:59:14.000Z',
            durationMs: 4_000,
          },
        },
      ],
      diagnostics: [
        {
          code: 'malformed-final-journal-line',
          journal: '.wdio-video-manifest/run/journals/0-0.jsonl',
          line: 2,
        },
      ],
    },
  ],
})

const clone = (): Record<string, unknown> => {
  return structuredClone(createManifest()) as unknown as Record<string, unknown>
}

const firstRecord = (value: unknown): Record<string, unknown> => {
  if (!Array.isArray(value) || !value[0] || typeof value[0] !== 'object') {
    throw new TypeError('Expected a populated record array in test fixture')
  }
  return value[0] as Record<string, unknown>
}

const firstRun = (
  manifest: Record<string, unknown>,
): Record<string, unknown> => {
  return firstRecord(manifest.runs)
}

const firstEntry = (run: Record<string, unknown>): Record<string, unknown> => {
  return firstRecord(run.entries)
}

describe('manifest v1 validator', () => {
  it('accepts ISO timestamps without milliseconds and with timezone offsets', () => {
    const manifest = clone()
    manifest.generatedAt = '2026-07-18T12:00:00Z'
    const run = firstRun(manifest)
    run.startedAt = '2026-07-18T07:00:00-05:00'
    run.completedAt = '2026-07-18T14:00:00.125+02:00'

    expect(validateVideoManifest(manifest)).toEqual({
      valid: true,
      errors: [],
    })
  })

  it.each([
    '2026-02-29T12:00:00Z',
    '2026-07-18',
    '2026-07-18T24:00:00Z',
    '2026-07-18T12:60:00Z',
    '2026-07-18T12:00:00+24:00',
  ])('rejects non-conforming timestamp %s', (timestamp) => {
    const manifest = clone()
    manifest.generatedAt = timestamp

    expect(validateVideoManifest(manifest)).toMatchObject({
      valid: false,
      errors: ['$.generatedAt must be an ISO-8601 timestamp'],
    })
  })

  it('accepts a complete manifest and additive optional fields', () => {
    const manifest = createManifest() as VideoManifestV1 & {
      futureOptionalField?: string
    }
    manifest.futureOptionalField = 'minor-compatible'

    expect(validateVideoManifest(manifest)).toEqual({ valid: true, errors: [] })
    expect(isVideoManifest(manifest)).toBe(true)
    expect(MANIFEST_SCHEMA_VERSION).toBe(1)
  })

  it.each([
    ['root', null, '$ must be an object'],
    [
      'schema version',
      () => {
        const manifest = clone()
        manifest.schemaVersion = 2
        return manifest
      },
      '$.schemaVersion must equal 1',
    ],
    [
      'generated timestamp',
      () => {
        const manifest = clone()
        manifest.generatedAt = 'yesterday'
        return manifest
      },
      '$.generatedAt must be an ISO-8601 timestamp',
    ],
    [
      'runs array',
      () => {
        const manifest = clone()
        manifest.runs = {}
        return manifest
      },
      '$.runs must be an array',
    ],
  ])('rejects an invalid %s', (_label, createValue, expectedError) => {
    const value =
      typeof createValue === 'function' ? createValue() : createValue
    const result = validateVideoManifest(value)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain(expectedError)
    expect(isVideoManifest(value)).toBe(false)
  })

  it('reports invalid run, tool, entry, and diagnostic fields', () => {
    const manifest = clone()
    const run = firstRun(manifest)
    run.id = ''
    run.startedAt = 'invalid'
    run.completedAt = 1
    run.exitCode = -1
    run.tools = {
      service: '',
      node: 24,
      webdriverio: null,
      puppeteer: [],
      ffmpeg: '',
    }
    run.entries = [null]
    run.diagnostics = [
      {
        code: 'unknown-code',
        journal: 'C:/private/journal.jsonl',
        line: 0,
      },
    ]

    const result = validateVideoManifest(manifest)
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        '$.runs[0].id must be a non-empty string',
        '$.runs[0].tools.ffmpeg must be a non-empty string',
        '$.runs[0].entries[0] must be an object',
        '$.runs[0].diagnostics[0].line must be an integer >= 1',
      ]),
    )
  })

  it('reports all invalid entry semantics without throwing', () => {
    const manifest = clone()
    const run = firstRun(manifest)
    const entry = firstEntry(run)
    entry.id = ''
    entry.runId = 1
    entry.cid = null
    entry.sessionHash = []
    entry.spec = {}
    entry.browser = {
      name: '',
      version: '',
      protocol: 'native-bidi',
    }
    entry.framework = 'tap'
    entry.scope = 'suite'
    entry.attempt = 0
    entry.result = 'flaky'
    entry.test = { name: '', fullName: '' }
    entry.capture = {
      decision: 'maybe',
      reason: '',
      segments: [
        {
          path: '../secret.webm',
          mimeType: 'text/plain',
          size: -1,
          width: 0,
        },
      ],
      final: null,
    }
    entry.processing = {
      timing: 'later',
      outcome: 'maybe',
      operation: 'upload',
      reason: '',
    }
    entry.timings = {
      startedAt: 'invalid',
      completedAt: false,
      durationMs: -1,
      captureStartedAt: 'invalid',
      captureStoppedAt: 1,
      processingStartedAt: [],
    }

    const result = validateVideoManifest(manifest)
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        '$.runs[0].entries[0].browser.protocol must be one of: bidi+cdp, classic+cdp, unsupported',
        '$.runs[0].entries[0].capture.segments[0].path must be a normalized relative path',
        '$.runs[0].entries[0].capture.segments[0].width and $.runs[0].entries[0].capture.segments[0].height must be provided together',
        '$.runs[0].entries[0].processing.operation must be one of: capture, merge, transcode',
      ]),
    )
  })

  it('requires nested objects and arrays', () => {
    const manifest = clone()
    const run = firstRun(manifest)
    const entry = firstEntry(run)
    entry.browser = null
    entry.test = 'test'
    entry.capture = []
    entry.processing = null
    entry.timings = 'now'
    run.tools = []
    run.diagnostics = {}

    const result = validateVideoManifest(manifest)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        '$.runs[0].tools must be an object',
        '$.runs[0].entries[0].browser must be an object',
        '$.runs[0].entries[0].test must be an object',
        '$.runs[0].entries[0].capture must be an object',
        '$.runs[0].entries[0].processing must be an object',
        '$.runs[0].entries[0].timings must be an object',
        '$.runs[0].diagnostics must be an array',
      ]),
    )
  })

  it('rejects non-object runs, artifacts, and diagnostics', () => {
    const manifest = clone()
    manifest.runs = [null]
    expect(validateVideoManifest(manifest).errors).toContain(
      '$.runs[0] must be an object',
    )

    const nested = clone()
    const run = firstRun(nested)
    const entry = firstEntry(run)
    const capture = entry.capture as Record<string, unknown>
    capture.segments = [null]
    run.diagnostics = [null]
    expect(validateVideoManifest(nested).errors).toEqual(
      expect.arrayContaining([
        '$.runs[0].entries[0].capture.segments[0] must be an object',
        '$.runs[0].diagnostics[0] must be an object',
      ]),
    )
  })

  it('handles invalid nested arrays without attempting iteration', () => {
    const manifest = clone()
    const run = firstRun(manifest)
    const entry = firstEntry(run)
    const capture = entry.capture as Record<string, unknown>
    run.entries = {}
    expect(validateVideoManifest(manifest).errors).toContain(
      '$.runs[0].entries must be an array',
    )

    run.entries = [entry]
    capture.segments = {}
    expect(validateVideoManifest(manifest).errors).toContain(
      '$.runs[0].entries[0].capture.segments must be an array',
    )
  })

  it.each(['/rooted.webm', 'C:/private.webm', 'folder\\file.webm'])(
    'rejects unsafe artifact path %s',
    (unsafePath) => {
      const manifest = clone()
      const run = firstRun(manifest)
      const entry = firstEntry(run)
      const capture = entry.capture as Record<string, unknown>
      const artifact = firstRecord(capture.segments)
      artifact.path = unsafePath
      expect(validateVideoManifest(manifest).valid).toBe(false)
    },
  )
})
