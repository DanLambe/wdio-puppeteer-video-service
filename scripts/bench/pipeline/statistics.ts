export interface Sample {
  elapsedMs: number
  rssBytes: number
  heapBytes: number
}

export interface WorkerMetrics {
  cid: string
  samples: Sample[]
  peakRssBytes: number
  eventLoop: { meanMs: number; p95Ms: number; maxMs: number }
  startupMs: number[]
  stopMs: number[]
  passed: number
  failed: number
}

export interface RunResult {
  schemaVersion: 1
  label: string
  pair: number
  variant: 'off' | 'baseline' | 'candidate'
  cpus: number
  workers: number
  retain: 'all' | 'failures'
  soak: boolean
  valid: boolean
  error?: string
  suiteMs: number
  workerMetrics: WorkerMetrics[]
  artifactBytes: number
  media: unknown[]
}

export const median = (values: number[]): number => {
  if (!values.length || values.some((value) => !Number.isFinite(value))) {
    throw new Error('A median needs finite observations')
  }
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

export const peakWorkerRss = (run: RunResult): number => {
  if (!run.workerMetrics.length) {
    throw new Error(`Missing worker observations: ${run.label}`)
  }
  return Math.max(...run.workerMetrics.map((worker) => worker.peakRssBytes))
}

/** Preserve complete pairs when resuming; rerun an interrupted pair together. */
export const completedPairs = (runs: RunResult[]): RunResult[] => {
  return runs.filter((run) => {
    if (run.soak) {
      return true
    }
    const pair = runs.filter(
      (other) =>
        !other.soak &&
        other.cpus === run.cpus &&
        other.workers === run.workers &&
        other.retain === run.retain &&
        other.pair === run.pair,
    )
    return (
      pair.some((observation) => !observation.valid) ||
      (pair.length === 3 &&
        ['off', 'baseline', 'candidate'].every(
          (variant) =>
            pair.filter((other) => other.variant === variant).length === 1,
        ))
    )
  })
}

const VARIANTS: readonly RunResult['variant'][] = [
  'off',
  'baseline',
  'candidate',
]

/**
 * Compare complete pairs only. Invalid or missing measurements cannot pass a
 * gate, and each status names whose measurement failed: an invalid candidate
 * fails qualification, while a baseline that cannot record a workload validly
 * is reported without ratios and does not hide the candidate's own result.
 */
export const compareRuns = (runs: RunResult[], requiredPairs = 5) => {
  const groups = new Map<string, RunResult[]>()
  for (const run of runs.filter((run) => !run.soak)) {
    const key = `${run.cpus}cpu-${run.workers}worker-${run.retain}`
    groups.set(key, [...(groups.get(key) ?? []), run])
  }
  return [...groups].map(([workload, observations]) => {
    const pairs = [...new Set(observations.map((run) => run.pair))].sort(
      (left, right) => left - right,
    )
    const present =
      pairs.length === requiredPairs &&
      pairs.every((pair) =>
        VARIANTS.every(
          (variant) =>
            observations.filter(
              (run) => run.pair === pair && run.variant === variant,
            ).length === 1,
        ),
      )
    if (!present) {
      return { workload, status: 'incomplete' as const }
    }
    const invalid = (variant: RunResult['variant']) =>
      observations
        .filter((run) => run.variant === variant && !run.valid)
        .map((run) => run.label)
    const candidateInvalid = invalid('candidate')
    if (candidateInvalid.length) {
      return {
        workload,
        status: 'candidate-invalid' as const,
        invalid: candidateInvalid,
      }
    }
    // Without a valid recording-disabled run, the environment itself is suspect.
    const controlInvalid = invalid('off')
    if (controlInvalid.length) {
      return {
        workload,
        status: 'incomplete' as const,
        invalid: controlInvalid,
      }
    }
    const baselineInvalid = invalid('baseline')
    if (baselineInvalid.length) {
      return {
        workload,
        status: 'baseline-invalid' as const,
        invalid: baselineInvalid,
      }
    }
    const ratios = pairs.map((pair) => {
      const pick = (variant: RunResult['variant']) =>
        observations.find(
          (run) => run.pair === pair && run.variant === variant,
        ) as RunResult
      const baseline = pick('baseline')
      const candidate = pick('candidate')
      const off = pick('off')
      if (
        Math.min(off.suiteMs, baseline.suiteMs, peakWorkerRss(baseline)) <= 0
      ) {
        throw new Error(`Invalid denominator in ${workload}`)
      }
      return {
        suite: candidate.suiteMs / baseline.suiteMs - 1,
        memory: peakWorkerRss(candidate) / peakWorkerRss(baseline) - 1,
        baselineOverhead: baseline.suiteMs / off.suiteMs - 1,
        candidateOverhead: candidate.suiteMs / off.suiteMs - 1,
      }
    })
    const suiteChange = median(ratios.map((value) => value.suite))
    const memoryChange = median(ratios.map((value) => value.memory))
    const suiteRegressionPairs = ratios.filter(
      (value) => value.suite > 0.1,
    ).length
    const memoryRegressionPairs = ratios.filter(
      (value) => value.memory > 0.15,
    ).length
    const blocker =
      (suiteChange > 0.1 && suiteRegressionPairs > requiredPairs / 2) ||
      (memoryChange > 0.15 && memoryRegressionPairs > requiredPairs / 2)
    return {
      workload,
      status: blocker ? ('investigate' as const) : ('pass' as const),
      suiteChange,
      memoryChange,
      suiteRegressionPairs,
      memoryRegressionPairs,
      baselineOverhead: median(ratios.map((value) => value.baselineOverhead)),
      candidateOverhead: median(ratios.map((value) => value.candidateOverhead)),
      pairs: ratios,
    }
  })
}

/**
 * A qualification passes when every expected workload passed or only its
 * baseline was invalid, and a full run's soak is present and valid.
 */
export const qualificationPassed = (
  runs: RunResult[],
  comparisons: ReturnType<typeof compareRuns>,
  expected: { readonly workloads: number; readonly soak: boolean },
): boolean => {
  const soak = runs.filter((run) => run.soak)
  return (
    comparisons.length === expected.workloads &&
    comparisons.every(
      (comparison) =>
        comparison.status === 'pass' ||
        comparison.status === 'baseline-invalid',
    ) &&
    (!expected.soak || (soak.length > 0 && soak.every((run) => run.valid)))
  )
}

/** Ignore warm-up and compare successive one-minute medians, retaining raw samples. */
export const summarizeSoak = (samples: Sample[]) => {
  if (!samples.some((sample) => sample.elapsedMs >= 300_000)) {
    throw new Error('Soak requires at least five minutes of worker samples')
  }
  const minutes = [1, 2, 3, 4].map((minute) =>
    samples.filter(
      (sample) =>
        sample.elapsedMs >= minute * 60_000 &&
        sample.elapsedMs < (minute + 1) * 60_000,
    ),
  )
  if (minutes.some((window) => window.length < 10)) {
    throw new Error('Soak requires at least five minutes of worker samples')
  }
  const rss = minutes.map((window) =>
    median(window.map((sample) => sample.rssBytes)),
  )
  const heap = minutes.map((window) =>
    median(window.map((sample) => sample.heapBytes)),
  )
  const growing = (values: number[]) =>
    values.slice(1).every((value, i) => value > (values[i] as number) * 1.02) &&
    (values.at(-1) as number) > (values[0] as number) * 1.15
  return {
    minuteMedianRssBytes: rss,
    minuteMedianHeapBytes: heap,
    continuingGrowth: growing(rss) || growing(heap),
  }
}
