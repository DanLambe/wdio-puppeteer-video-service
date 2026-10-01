import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import {
  compareRuns,
  completedPairs,
  median,
  qualificationPassed,
  type RunResult,
  summarizeSoak,
} from '../../scripts/bench/pipeline/statistics.js'

const fixtureRuns = (): RunResult[] =>
  Array.from({ length: 5 }, (_, index) =>
    ['off', 'baseline', 'candidate'].map(
      (variant): RunResult => ({
        schemaVersion: 1,
        label: variant,
        pair: index + 1,
        variant: variant as RunResult['variant'],
        cpus: 2,
        workers: 2,
        retain: 'all',
        soak: false,
        valid: true,
        suiteMs: variant === 'off' ? 80 : 100,
        workerMetrics: [
          {
            cid: '0-0',
            samples: [],
            peakRssBytes: 100,
            eventLoop: { meanMs: 1, p95Ms: 2, maxMs: 3 },
            startupMs: [],
            stopMs: [],
            passed: 2,
            failed: 0,
          },
        ],
        artifactBytes: 0,
        media: [],
      }),
    ),
  ).flat()

describe('paired pipeline investigation gates', () => {
  it('reports multi-digit pair identifiers in numeric order', () => {
    const runs = fixtureRuns().filter((run) => run.pair <= 3)
    const identifiers = [10, 2, 1]
    for (const run of runs) {
      run.pair = identifiers[run.pair - 1] as number
      if (run.variant === 'candidate') {
        run.suiteMs = 100 + run.pair
      }
    }
    const comparison = compareRuns(runs, 3)[0]
    expect(comparison?.status).toBe('pass')
    expect(
      comparison?.pairs?.map((pair) => Math.round(pair.suite * 100)),
    ).toEqual([1, 2, 10])
  })
  it('uses median paired ratios and recording-disabled overhead', () => {
    const runs = fixtureRuns()
    for (const run of runs.filter((run) => run.pair === 5)) {
      run.suiteMs *= 10
    }
    expect(compareRuns(runs)[0]).toMatchObject({
      status: 'pass',
      suiteChange: 0,
      memoryChange: 0,
      baselineOverhead: 0.25,
      candidateOverhead: 0.25,
    })
  })
  it.each(['suite', 'memory'])(
    'blocks a repeatable %s regression',
    (metric) => {
      const runs = fixtureRuns()
      for (const run of runs.filter(
        (run) => run.variant === 'candidate' && run.pair <= 3,
      )) {
        if (metric === 'suite') {
          run.suiteMs = 112
        } else {
          const worker = run.workerMetrics[0]
          assert.ok(worker)
          worker.peakRssBytes = 116
        }
      }
      expect(compareRuns(runs)[0]?.status).toBe('investigate')
    },
  )
  it('does not treat one outlier as a repeatable regression', () => {
    const runs = fixtureRuns()
    const candidate = runs.find((run) => run.variant === 'candidate')
    assert.ok(candidate)
    candidate.suiteMs = 1_000
    expect(compareRuns(runs)[0]?.status).toBe('pass')
  })
  it.each(['missing', 'invalid', 'duplicate'])(
    'rejects %s observations',
    (kind) => {
      const runs = fixtureRuns()
      if (kind === 'missing') {
        runs.pop()
      } else if (kind === 'invalid') {
        assert.ok(runs[0])
        runs[0].valid = false
      } else {
        runs.push(runs[0] as RunResult)
      }
      expect(compareRuns(runs)[0]?.status).toBe('incomplete')
    },
  )
  // A baseline that could not record a workload validly (RC5 under the
  // oversubscribed retained shape) must not decide the candidate's result.
  it('reports an invalid baseline without failing a valid candidate', () => {
    const runs = fixtureRuns()
    for (const run of runs.filter((run) => run.variant === 'baseline')) {
      run.valid = false
      run.label = `baseline-${run.pair.toString()}`
    }
    const comparisons = compareRuns(runs)
    expect(comparisons).toEqual([
      {
        workload: '2cpu-2worker-all',
        status: 'baseline-invalid',
        invalid: [1, 2, 3, 4, 5].map((pair) => `baseline-${pair.toString()}`),
      },
    ])
    expect(
      qualificationPassed(runs, comparisons, { workloads: 1, soak: false }),
    ).toBe(true)
  })
  it.each([true, false])(
    'fails an invalid candidate whatever the baseline did (baseline invalid: %s)',
    (baselineInvalid) => {
      const runs = fixtureRuns()
      for (const run of runs) {
        if (run.variant === 'candidate' && run.pair === 3) {
          run.valid = false
          run.label = 'broken-candidate'
        }
        if (run.variant === 'baseline' && baselineInvalid) {
          run.valid = false
        }
      }
      const comparisons = compareRuns(runs)
      expect(comparisons[0]).toEqual({
        workload: '2cpu-2worker-all',
        status: 'candidate-invalid',
        invalid: ['broken-candidate'],
      })
      expect(
        qualificationPassed(runs, comparisons, { workloads: 1, soak: false }),
      ).toBe(false)
    },
  )
  it('treats an invalid recording-disabled run as an incomplete environment', () => {
    const runs = fixtureRuns()
    const off = runs.find((run) => run.variant === 'off')
    assert.ok(off)
    off.valid = false
    const comparisons = compareRuns(runs)
    expect(comparisons[0]).toMatchObject({
      status: 'incomplete',
      invalid: ['off'],
    })
    expect(
      qualificationPassed(runs, comparisons, { workloads: 1, soak: false }),
    ).toBe(false)
  })
  it('requires every expected workload and a valid soak to qualify', () => {
    const runs = fixtureRuns()
    const comparisons = compareRuns(runs)
    const soak = { ...(runs[2] as RunResult), soak: true, label: 'soak' }
    const qualifies = (all: RunResult[], workloads = 1) =>
      qualificationPassed(all, comparisons, { workloads, soak: true })
    expect(qualifies(runs)).toBe(false)
    expect(qualifies([...runs, { ...soak, valid: false }])).toBe(false)
    expect(qualifies([...runs, soak])).toBe(true)
    expect(qualifies([...runs, soak], 2)).toBe(false)
    const regressed = fixtureRuns()
    for (const run of regressed.filter((run) => run.variant === 'candidate')) {
      run.suiteMs = 150
    }
    expect(
      qualificationPassed(regressed, compareRuns(regressed), {
        workloads: 1,
        soak: false,
      }),
    ).toBe(false)
  })
  it('rejects zero denominators and missing memory samples', () => {
    const runs = fixtureRuns()
    assert.ok(runs[0] && runs[1])
    runs[0].suiteMs = 0
    expect(() => compareRuns(runs)).toThrow('denominator')
    runs[0].suiteMs = 80
    runs[1].workerMetrics = []
    expect(() => compareRuns(runs)).toThrow('Missing worker')
  })
  it('calculates even medians without changing observations', () => {
    const values = [4, 1, 3, 2]
    expect(median(values)).toBe(2.5)
    expect(values).toEqual([4, 1, 3, 2])
    expect(() => median([])).toThrow()
    expect(() => median([Number.NaN])).toThrow()
  })
})

describe('five-minute memory soak', () => {
  const samples = (growing: boolean) =>
    Array.from({ length: 301 }, (_, second) => ({
      elapsedMs: second * 1_000,
      rssBytes: growing ? 100 + second : 100 + (second % 10),
      heapBytes: 50 + (second % 10),
    }))
  it('distinguishes continuing growth from bounded collection cycles', () => {
    expect(summarizeSoak(samples(false)).continuingGrowth).toBe(false)
    expect(summarizeSoak(samples(true)).continuingGrowth).toBe(true)
  })
  it('rejects a truncated soak', () => {
    expect(() => summarizeSoak(samples(false).slice(0, 200))).toThrow(
      'five minutes',
    )
  })
})

describe('interrupted pipeline measurements', () => {
  it('keeps complete pairs and reruns a partially completed healthy pair together', () => {
    const runs = fixtureRuns().slice(0, 5)
    expect(completedPairs(runs)).toEqual(runs.slice(0, 3))
  })
  it('preserves failed observations instead of retrying them into a pass', () => {
    const runs = fixtureRuns().slice(0, 5)
    const failed = runs[3]
    assert.ok(failed)
    failed.valid = false
    expect(completedPairs(runs)).toEqual(runs)
  })
  it('does not mistake duplicate variants for a complete pair', () => {
    const runs = fixtureRuns().slice(0, 2)
    expect(completedPairs([...runs, runs[0] as RunResult])).toEqual([])
  })
})
