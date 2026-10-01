import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManifestEntryV1, ManifestRunV1 } from '../../src/manifest.js'
import { renderStaticVideoReport } from '../../src/reporter/html-renderer.js'
import {
  createReportModel,
  type ReportModel,
} from '../../src/reporter/report-model.js'
import type {
  ReporterFragmentV1,
  ReporterTestOutcome,
} from '../../src/reporter/types.js'

const tempDirs: string[] = []
const startedAt = '2026-07-18T00:00:00.000Z'
const completedAt = '2026-07-18T00:00:02.000Z'

const createTempDir = async (): Promise<string> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'report-components-'))
  tempDirs.push(tempDir)
  return tempDir
}

const createOutcome = (runId: string): ReporterTestOutcome => ({
  uid: 'outcome-1',
  runId,
  cid: '0-0',
  spec: 'tests/specs/report.ts',
  browser: { name: 'chrome' },
  test: { name: 'reported test' },
  attempt: 1,
  retried: false,
  status: 'passed',
  durationMs: 25,
})

const createFragment = (
  runId: string,
  completion: string,
  outcomes: ReporterTestOutcome[],
): ReporterFragmentV1 => ({
  schemaVersion: 1,
  runId,
  cid: '0-0',
  specs: ['tests/specs/report.ts'],
  browser: { name: 'chrome' },
  reportFileName: 'video-report.html',
  startedAt,
  completedAt: completion,
  outcomes,
})

const createEntryWithoutTest = (runId: string): ManifestEntryV1 => ({
  id: 'unmatched-entry',
  runId,
  cid: '0-0',
  sessionHash: 'hash',
  browser: { name: 'chrome', protocol: 'bidi+cdp' },
  framework: 'mocha',
  spec: 'tests/specs/report.ts',
  scope: 'test',
  attempt: 1,
  result: 'failed',
  capture: {
    decision: 'recorded',
    segments: [
      {
        path: 'missing.webm',
        mimeType: 'video/webm',
        size: 10,
      },
    ],
  },
  processing: { timing: 'after-test', outcome: 'not-required' },
  timings: { startedAt, completedAt, durationMs: 2000 },
})

const createRun = (
  runId: string,
  entries: ManifestEntryV1[],
): ManifestRunV1 => ({
  id: runId,
  startedAt,
  completedAt,
  exitCode: 0,
  tools: {
    service: '1.0.0-rc.1',
    node: 'v24.0.0',
    webdriverio: '9.29.1',
    puppeteer: '24.11.2',
  },
  entries,
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    tempDirs
      .splice(0)
      .map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })),
  )
})

describe('report identity and media checks', () => {
  const entry = (id: string, fullName?: string): ManifestEntryV1 => ({
    ...createEntryWithoutTest('identity-run'),
    id,
    test: { name: 'same title', ...(fullName ? { fullName } : {}) },
    capture: { decision: 'skipped', reason: id, segments: [] },
  })
  const outcome = (uid: string, fullName?: string): ReporterTestOutcome => ({
    ...createOutcome('identity-run'),
    uid,
    test: { name: 'same title', ...(fullName ? { fullName } : {}) },
  })
  const report = async (
    entries: ManifestEntryV1[],
    outcomes: ReporterTestOutcome[],
  ): Promise<ReportModel> =>
    createReportModel({
      outputDir: await createTempDir(),
      runId: 'identity-run',
      run: createRun('identity-run', entries),
      fragments: [createFragment('identity-run', completedAt, outcomes)],
      initialDiagnostics: [],
    })

  it('prefers full names when outcomes arrive in a different suite order', async () => {
    const model = await report(
      [entry('A', 'suite A same title'), entry('B', 'suite B same title')],
      [outcome('B', 'suite B same title'), outcome('A', 'suite A same title')],
    )
    expect(model.items.map((item) => item.captureReason)).toEqual(['B', 'A'])
    expect(model.diagnostics).toEqual([])
  })

  it('does not use a short title when both full names disagree', async () => {
    const model = await report(
      [entry('A', 'suite A same title')],
      [outcome('B', 'suite B same title')],
    )
    expect(
      model.items.find((item) => item.id === '0-0-B-1')?.captureDecision,
    ).toBeUndefined()
    expect(model.diagnostics.map((item) => item.code)).toEqual([
      'unmatched-manifest-entry',
      'unmatched-test-outcome',
    ])
  })

  it.each(['entry', 'outcome'] as const)(
    'uses a unique short title when the %s lacks a full name',
    async (missing) => {
      const model = await report(
        [entry('A', missing === 'entry' ? undefined : 'suite A same title')],
        [
          outcome(
            'A',
            missing === 'outcome' ? undefined : 'suite A same title',
          ),
        ],
      )
      expect(model.items[0]?.captureReason).toBe('A')
      expect(model.diagnostics).toEqual([])
    },
  )

  it('reports ambiguous short titles without claiming either capture', async () => {
    const model = await report(
      [entry('A', 'suite A same title'), entry('B', 'suite B same title')],
      [outcome('unknown')],
    )
    expect(
      model.items.find((item) => item.id === '0-0-unknown-1')?.captureDecision,
    ).toBeUndefined()
    expect(
      model.items.filter((item) => item.id.startsWith('manifest-')),
    ).toHaveLength(2)
    expect(model.diagnostics.map((item) => item.code)).toEqual([
      'ambiguous-test-outcome',
      'unmatched-manifest-entry',
      'unmatched-manifest-entry',
    ])
  })

  it.each(['first', 'last'] as const)(
    'resolves exact identities before a short-title outcome arriving %s',
    async (position) => {
      const exact = [
        outcome('B', 'suite B same title'),
        outcome('A', 'suite A same title'),
      ]
      const model = await report(
        [entry('A', 'suite A same title'), entry('B', 'suite B same title')],
        position === 'first'
          ? [outcome('unknown'), ...exact]
          : [...exact, outcome('unknown')],
      )
      expect(
        model.items.find((item) => item.id === '0-0-unknown-1')
          ?.captureDecision,
      ).toBeUndefined()
      expect(
        model.items.find((item) => item.id === '0-0-B-1')?.captureReason,
      ).toBe('B')
      expect(
        model.items.find((item) => item.id === '0-0-A-1')?.captureReason,
      ).toBe('A')
      expect(model.diagnostics.map((item) => item.code)).toEqual([
        'unmatched-test-outcome',
      ])
    },
  )

  it('keeps exact duplicate occurrences ordered and removes claimed fallback candidates', async () => {
    const model = await report(
      [
        entry('A1', 'suite A same title'),
        entry('A2', 'suite A same title'),
        entry('B', 'suite B same title'),
      ],
      [
        outcome('A1', 'suite A same title'),
        outcome('A2', 'suite A same title'),
        outcome('B'),
      ],
    )
    expect(model.items.map((item) => item.captureReason)).toEqual([
      'A1',
      'A2',
      'B',
    ])
    expect(model.diagnostics).toEqual([])
  })

  it('does not choose between two different fallback aliases', async () => {
    const fullAlias = entry('full-alias')
    fullAlias.test = { name: 'suite same title' }
    const model = await report(
      [entry('short-alias'), fullAlias],
      [outcome('unknown', 'suite same title')],
    )
    expect(
      model.items.find((item) => item.id === '0-0-unknown-1')?.media,
    ).toEqual([])
    expect(model.diagnostics.map((item) => item.code)).toContain(
      'ambiguous-test-outcome',
    )
  })

  it.each(['first', 'last'] as const)(
    'keeps a capture for its exact identity when a short-title outcome arrives %s',
    async (position) => {
      const exact = outcome('exact', 'suite same title')
      const model = await report(
        [entry('A', 'suite same title')],
        position === 'first'
          ? [outcome('short'), exact]
          : [exact, outcome('short')],
      )
      expect(
        model.items.find((item) => item.id === '0-0-exact-1')?.captureReason,
      ).toBe('A')
      expect(
        model.items.find((item) => item.id === '0-0-short-1')?.captureDecision,
      ).toBeUndefined()
      expect(model.diagnostics.map((item) => item.code)).toEqual([
        'unmatched-test-outcome',
      ])
    },
  )

  it.each(['first', 'last'] as const)(
    'keeps a top-level capture from a nested same-titled test arriving %s',
    async (position) => {
      const nested = outcome('nested', 'suite same title')
      const topLevel = outcome('top-level', 'same title')
      const model = await report(
        [entry('top-level', 'same title')],
        position === 'first' ? [nested, topLevel] : [topLevel, nested],
      )
      expect(
        model.items.find((item) => item.id === '0-0-top-level-1')
          ?.captureReason,
      ).toBe('top-level')
      expect(
        model.items.find((item) => item.id === '0-0-nested-1')?.captureDecision,
      ).toBeUndefined()
    },
  )

  it.each(['recorded', 'reversed'] as const)(
    'keeps full titles that differ only in case on their own captures in %s order',
    async (order) => {
      const exact = [
        outcome('upper', 'ADMIN same title'),
        outcome('title', 'Admin same title'),
      ]
      const model = await report(
        [
          entry('upper', 'ADMIN same title'),
          entry('title', 'Admin same title'),
        ],
        order === 'recorded' ? exact : exact.toReversed(),
      )
      expect(
        model.items.find((item) => item.id === '0-0-upper-1')?.captureReason,
      ).toBe('upper')
      expect(
        model.items.find((item) => item.id === '0-0-title-1')?.captureReason,
      ).toBe('title')
      expect(model.diagnostics).toEqual([])
    },
  )

  it.each([
    ['spacing', 'suite  A\tsame title', 'suite A same title'],
    ['case', 'Suite A same title', 'suite a same title'],
    ['Unicode form', 'caf\u00e9 same title', 'cafe\u0301 same title'],
  ])(
    'matches a unique full title that differs only in %s',
    async (_label, recorded, reported) => {
      const model = await report(
        [entry('A', recorded)],
        [outcome('A', reported)],
      )
      expect(model.items.map((item) => item.captureReason)).toEqual(['A'])
      expect(model.diagnostics).toEqual([])
    },
  )

  it.each([
    ['without an exact match', [outcome('other', 'admin same title')]],
    [
      'after one capture matched exactly',
      [
        outcome('upper', 'ADMIN same title'),
        outcome('other', 'admin same title'),
      ],
    ],
  ])(
    'reports titles that only normalization joins as ambiguous %s',
    async (_label, outcomes) => {
      const model = await report(
        [
          entry('upper', 'ADMIN same title'),
          entry('title', 'Admin same title'),
        ],
        outcomes,
      )
      // Never chosen by elimination: "admin" may describe the claimed one.
      expect(
        model.items.find((item) => item.id === '0-0-other-1')?.captureDecision,
      ).toBeUndefined()
      expect(
        model.diagnostics.filter(
          (item) => item.code === 'ambiguous-test-outcome',
        ),
      ).toHaveLength(1)
    },
  )

  it.each(['first', 'last'] as const)(
    'keeps a capture for its exact full title when a variant arrives %s',
    async (position) => {
      const exact = outcome('exact', 'Admin same title')
      const variant = outcome('variant', 'admin same title')
      const model = await report(
        [entry('A', 'Admin same title')],
        position === 'first' ? [variant, exact] : [exact, variant],
      )
      expect(
        model.items.find((item) => item.id === '0-0-exact-1')?.captureReason,
      ).toBe('A')
      expect(
        model.items.find((item) => item.id === '0-0-variant-1')
          ?.captureDecision,
      ).toBeUndefined()
      expect(model.diagnostics.map((item) => item.code)).toEqual([
        'unmatched-test-outcome',
      ])
    },
  )

  describe('spec paths that differ only in case', () => {
    // On a case-sensitive filesystem these are different files.
    const upper = 'tests/ADMIN.ts'
    const lower = 'tests/admin.ts'
    const inSpec = <T extends { spec: string }>(value: T, spec: string): T => ({
      ...value,
      spec,
    })
    const specCapture = (id: string, spec: string): ManifestEntryV1 => ({
      ...createEntryWithoutTest('identity-run'),
      id,
      spec,
      scope: 'spec',
      capture: { decision: 'skipped', reason: id, segments: [] },
    })
    const reasonOf = (model: ReportModel, uid: string) =>
      model.items.find((item) => item.id === `0-0-${uid}-1`)?.captureReason

    it.each(['recorded', 'reversed'] as const)(
      'keeps same-titled tests on their own spec captures in %s order',
      async (order) => {
        const outcomes = [
          inSpec(outcome('upper', 'suite same title'), upper),
          inSpec(outcome('lower', 'suite same title'), lower),
        ]
        const model = await report(
          [
            inSpec(entry('upper', 'suite same title'), upper),
            inSpec(entry('lower', 'suite same title'), lower),
          ],
          order === 'recorded' ? outcomes : outcomes.toReversed(),
        )
        expect(reasonOf(model, 'upper')).toBe('upper')
        expect(reasonOf(model, 'lower')).toBe('lower')
        expect(model.diagnostics).toEqual([])
      },
    )

    it.each(['recorded', 'reversed'] as const)(
      'keeps spec-level captures on their own spec in %s order',
      async (order) => {
        const outcomes = [
          inSpec(outcome('upper', 'suite same title'), upper),
          inSpec(outcome('lower', 'suite same title'), lower),
        ]
        const model = await report(
          [specCapture('upper', upper), specCapture('lower', lower)],
          order === 'recorded' ? outcomes : outcomes.toReversed(),
        )
        expect(reasonOf(model, 'upper')).toBe('upper')
        expect(reasonOf(model, 'lower')).toBe('lower')
        expect(model.diagnostics).toEqual([])
      },
    )

    it.each([
      ['only in case', 'tests/Admin.ts', 'tests/admin.ts'],
      [
        'in separators and a leading dot',
        `./${path.win32.join('tests', 'specs', 'report.ts')}`,
        'tests/specs/report.ts',
      ],
    ])(
      'matches the one recorded spelling of a spec path that differs %s',
      async (_label, recorded, reported) => {
        const model = await report(
          [inSpec(entry('A', 'suite same title'), recorded)],
          [inSpec(outcome('A', 'suite same title'), reported)],
        )
        expect(reasonOf(model, 'A')).toBe('A')
        expect(model.diagnostics).toEqual([])
      },
    )

    it.each(['test', 'spec'] as const)(
      'does not choose between two recorded spellings for a %s capture',
      async (scope) => {
        const captures =
          scope === 'test'
            ? [
                inSpec(entry('upper', 'suite same title'), upper),
                inSpec(entry('lower', 'suite same title'), lower),
              ]
            : [specCapture('upper', upper), specCapture('lower', lower)]
        const model = await report(captures, [
          inSpec(outcome('other', 'suite same title'), 'tests/Admin.ts'),
        ])
        expect(
          model.items.find((item) => item.id === '0-0-other-1')
            ?.captureDecision,
        ).toBeUndefined()
        expect(
          model.diagnostics.filter(
            (item) => item.code === 'ambiguous-test-outcome',
          ),
        ).toHaveLength(1)
        // Neither capture is claimed, so both stay visible on their own.
        expect(
          model.items.filter((item) => item.captureDecision !== undefined),
        ).toHaveLength(2)
      },
    )
  })

  describe('top-level titles, recorded with the title as both names', () => {
    const topLevelEntry = (id: string, title: string): ManifestEntryV1 => ({
      ...entry(id),
      test: { name: title, fullName: title },
    })
    // Some reporters send only a short name, which the fallback pass matches.
    const topLevelOutcome = (
      uid: string,
      title: string,
      withFullName = true,
    ): ReporterTestOutcome => ({
      ...outcome(uid),
      test: withFullName ? { name: title, fullName: title } : { name: title },
    })
    const captureOf = (model: ReportModel, uid: string) =>
      model.items.find((item) => item.id === `0-0-${uid}-1`)?.captureReason
    const unmatchedCaptures = (model: ReportModel) =>
      model.items
        .filter((item) => item.id.startsWith('manifest-'))
        .map((item) => item.captureReason)

    it.each([
      ['case', 'ADMIN', 'Admin'],
      ['spacing', 'Admin page', 'Admin  page'],
      ['Unicode form', 'caf\u00e9', 'cafe\u0301'],
    ])(
      'never gives an exhausted %s spelling the other spelling capture',
      async (_label, spelling, other) => {
        // More outcomes than captures of one spelling: the extra outcome must
        // be diagnosed, not attached to the only capture left unclaimed.
        for (const withFullName of [true, false]) {
          const model = await report(
            [topLevelEntry('own', spelling), topLevelEntry('other', other)],
            [
              topLevelOutcome('first', spelling),
              topLevelOutcome('second', spelling, withFullName),
            ],
          )
          expect(captureOf(model, 'first')).toBe('own')
          expect(captureOf(model, 'second')).toBeUndefined()
          expect(unmatchedCaptures(model)).toEqual(['other'])
          expect(model.diagnostics.map((item) => item.code)).toEqual([
            'unmatched-manifest-entry',
            'unmatched-test-outcome',
          ])
        }
      },
    )

    it.each(['first', 'last'] as const)(
      'does not give a short-name outcome arriving %s another spelling capture',
      async (position) => {
        const exact = topLevelOutcome('exact', 'ADMIN')
        const short = topLevelOutcome('short', 'ADMIN', false)
        const model = await report(
          [topLevelEntry('upper', 'ADMIN'), topLevelEntry('title', 'Admin')],
          position === 'first' ? [short, exact] : [exact, short],
        )
        expect(captureOf(model, 'exact')).toBe('upper')
        expect(captureOf(model, 'short')).toBeUndefined()
        expect(unmatchedCaptures(model)).toEqual(['title'])
      },
    )

    it.each([
      ['ADMIN', 'ADMIN', 'Admin'],
      ['ADMIN', 'Admin', 'ADMIN'],
      ['Admin', 'ADMIN', 'ADMIN'],
    ])(
      'gives each spelling its own capture and diagnoses the extra one: %s, %s, %s',
      async (...titles) => {
        const model = await report(
          [topLevelEntry('upper', 'ADMIN'), topLevelEntry('title', 'Admin')],
          titles.map((title, index) =>
            topLevelOutcome(`${title}-${index.toString()}`, title),
          ),
        )
        const byTitle = titles.map((title, index) => [
          title,
          captureOf(model, `${title}-${index.toString()}`),
        ])
        // The first "ADMIN" takes the capture; the second has none.
        expect(byTitle.filter(([title]) => title === 'ADMIN')).toEqual([
          ['ADMIN', 'upper'],
          ['ADMIN', undefined],
        ])
        expect(byTitle.find(([title]) => title === 'Admin')).toEqual([
          'Admin',
          'title',
        ])
        expect(model.diagnostics.map((item) => item.code)).toEqual([
          'unmatched-test-outcome',
        ])
      },
    )

    it.each([
      ['alone', []],
      [
        'after one capture matched exactly',
        [topLevelOutcome('exact', 'ADMIN')],
      ],
    ])(
      'reports a short name that only normalization joins as ambiguous %s',
      async (_label, others) => {
        const model = await report(
          [topLevelEntry('upper', 'ADMIN'), topLevelEntry('title', 'Admin')],
          [...others, topLevelOutcome('short', 'admin', false)],
        )
        expect(captureOf(model, 'short')).toBeUndefined()
        expect(unmatchedCaptures(model)).toContain('title')
        expect(
          model.diagnostics.filter(
            (item) => item.code === 'ambiguous-test-outcome',
          ),
        ).toHaveLength(1)
      },
    )

    it('still matches truly identical titles to their captures in order', async () => {
      const model = await report(
        [topLevelEntry('one', 'ADMIN'), topLevelEntry('two', 'ADMIN')],
        [topLevelOutcome('first', 'ADMIN'), topLevelOutcome('second', 'ADMIN')],
      )
      expect(captureOf(model, 'first')).toBe('one')
      expect(captureOf(model, 'second')).toBe('two')
      expect(model.diagnostics).toEqual([])
    })

    it.each([true, false])(
      'still matches a unique spelling variant (full name: %s)',
      async (withFullName) => {
        const model = await report(
          [topLevelEntry('A', 'Admin page')],
          [topLevelOutcome('variant', 'admin  PAGE', withFullName)],
        )
        expect(captureOf(model, 'variant')).toBe('A')
        expect(model.diagnostics).toEqual([])
      },
    )
  })

  it('matches a scenario-level Cucumber outcome to its recorded scenario name', async () => {
    // With scenarioLevelReporter, WDIO prefixes the full title with the
    // feature id, while the service records the scenario name as both names.
    const scenario = outcome('scenario', 'video-naming.feature:1:1: same title')
    scenario.test.parent = 'video-naming.feature:1:1'
    const model = await report([entry('scenario', 'same title')], [scenario])
    expect(model.items.map((item) => item.captureReason)).toEqual(['scenario'])
    expect(model.diagnostics).toEqual([])
  })

  it('reports same-titled scenario-level Cucumber outcomes as ambiguous', async () => {
    const scenarios = ['first', 'second'].map((uid) => {
      const scenario = outcome(uid, 'video-naming.feature:1:1: same title')
      scenario.test.parent = 'video-naming.feature:1:1'
      return scenario
    })
    const model = await report(
      [entry('first', 'same title'), entry('second', 'same title')],
      scenarios,
    )
    expect(
      model.items
        .filter((item) => !item.id.startsWith('manifest-'))
        .map((item) => item.media),
    ).toEqual([[], []])
    expect(
      model.diagnostics.filter(
        (item) => item.code === 'ambiguous-test-outcome',
      ),
    ).toHaveLength(2)
  })

  it.each(['cid', 'spec', 'attempt', 'runId'] as const)(
    'separates identical names by %s',
    async (field) => {
      const other = entry('other', 'suite same title')
      if (field === 'attempt') {
        other.attempt = 2
      } else {
        other[field] = 'other'
      }
      const model = await report(
        [other, entry('target', 'suite same title')],
        [outcome('target', 'suite same title')],
      )
      expect(
        model.items.find((item) => item.id === '0-0-target-1')?.captureReason,
      ).toBe('target')
    },
  )

  it('does not associate a step title with a different scenario when its container is missing', async () => {
    const step = outcome('step', 'same title')
    step.test.containerName = 'missing scenario'
    const model = await report([entry('other', 'same title')], [step])
    expect(
      model.items.find((item) => item.id === '0-0-step-1')?.captureDecision,
    ).toBeUndefined()
  })

  it('checks shared media once with no more than eight outstanding filesystem operations', async () => {
    let active = 0
    let peak = 0
    const stat = vi.spyOn(fs, 'stat').mockImplementation(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => setImmediate(resolve))
      active -= 1
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    const entries = Array.from({ length: 40 }, (_, index) => {
      const item = entry(String(index), `suite ${index}`)
      item.capture.segments = [
        { path: `video-${index % 20}.webm`, mimeType: 'video/webm', size: 1 },
      ]
      return item
    })
    const model = await report(
      entries,
      entries.map((item) => outcome(item.id, item.test?.fullName)),
    )
    expect(stat).toHaveBeenCalledTimes(20)
    expect(peak).toBe(8)
    expect(
      model.items.every((item) => item.media[0]?.available === false),
    ).toBe(true)
    expect(
      model.diagnostics.filter(
        (item) => item.code === 'missing-media-artifact',
      ),
    ).toHaveLength(20)
  })
})

describe('report model and HTML renderer', () => {
  it('uses the latest fragment completion time without a manifest', async () => {
    const outputDir = await createTempDir()
    const runId = 'fragment-only-run'
    const model = await createReportModel({
      outputDir,
      runId,
      fragments: [
        createFragment(runId, '2026-07-18T00:00:01.000Z', [
          createOutcome(runId),
        ]),
        createFragment(runId, completedAt, []),
      ],
      run: undefined,
      initialDiagnostics: [],
    })

    expect(model.generatedAt).toBe(completedAt)
    expect(model.items).toEqual([
      expect.objectContaining({ browser: 'chrome', testName: 'reported test' }),
    ])
    expect(model.diagnostics).toEqual([])
  })

  it('reports unmatched entities and missing media in stable order', async () => {
    const outputDir = await createTempDir()
    const runId = 'unmatched-run'
    const model = await createReportModel({
      outputDir,
      runId,
      fragments: [createFragment(runId, completedAt, [createOutcome(runId)])],
      run: createRun(runId, [createEntryWithoutTest(runId)]),
      initialDiagnostics: [],
    })

    expect(model.items).toHaveLength(2)
    expect(model.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'missing-media-artifact',
      'unmatched-manifest-entry',
      'unmatched-test-outcome',
    ])
  })

  it('uses an epoch fallback and sorts equal diagnostic codes by message', async () => {
    const model = await createReportModel({
      outputDir: await createTempDir(),
      runId: 'empty-run',
      fragments: [],
      run: undefined,
      initialDiagnostics: [
        { code: 'invalid-manifest', message: 'z-last' },
        { code: 'invalid-manifest', message: 'a-first' },
      ],
    })

    expect(model.generatedAt).toBe(new Date(0).toISOString())
    expect(model.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'a-first',
      'z-last',
    ])
    expect(renderStaticVideoReport(model)).toContain(
      'No test outcomes were captured.',
    )
  })

  it('renders deterministic CSP, error, and large-media markup', () => {
    const model: ReportModel = {
      runId: 'stable-render',
      generatedAt: completedAt,
      diagnostics: [],
      items: [
        {
          id: 'failed-item',
          status: 'failed',
          spec: 'tests/specs/report.ts',
          browser: 'chrome 140',
          testName: 'failed test',
          attempt: 1,
          retried: false,
          durationMs: 25,
          errors: [{ message: 'boom', stack: 'trace-only' }],
          media: [
            {
              path: 'large.webm',
              href: './large.webm',
              mimeType: 'video/webm',
              size: 2 * 1024 * 1024,
              available: true,
            },
          ],
        },
      ],
    }

    const first = renderStaticVideoReport(model)
    expect(renderStaticVideoReport(model)).toBe(first)
    expect(first).toContain('boom\ntrace-only')
    expect(first).toContain('2.0 MiB')

    // The policy has to hash what the report actually ships, so recompute both
    // digests from the emitted blocks: any drift between the constants and the
    // markup, or any later edit to either block, stops them from matching and
    // the browser would refuse to run the report.
    const script = /<script>([\s\S]*?)<\/script>/u.exec(first)?.[1]
    const styles = /<style>([\s\S]*?)<\/style>/u.exec(first)?.[1]
    expect(script).toBeDefined()
    expect(styles).toBeDefined()
    expect(first).toContain(`script-src '${digestOf(script as string)}'`)
    expect(first).toContain(`style-src '${digestOf(styles as string)}'`)
    // A nonce that is reproducible is not a nonce, and `frame-ancestors` is
    // ignored in a meta policy, so neither belongs in a static report.
    expect(first).not.toContain('nonce')
    expect(first).not.toContain('frame-ancestors')
  })
})

const digestOf = (content: string): string =>
  `sha256-${createHash('sha256').update(content, 'utf8').digest('base64')}`
