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
  /** Command timings from the tab-switching workload, across all workers. */
  switching?: SwitchTimings
}

/** Crossings between the two held tabs in each switching test. */
export const SWITCH_CROSSINGS = 10

export interface SwitchTimings {
  /** The first driving command after moving to the other tab. */
  crossingMs: number[]
  /** The same command again, on the tab just moved to. */
  sameTabMs: number[]
}

export const VARIANTS: readonly RunResult['variant'][] = [
  'off',
  'baseline',
  'candidate',
]

/** 1.0.0 cannot follow held tabs, so tab switching compares with recording off. */
export const SWITCHING_VARIANTS: readonly RunResult['variant'][] = [
  'off',
  'candidate',
]

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
export const completedPairs = (
  runs: RunResult[],
  variants: readonly RunResult['variant'][] = VARIANTS,
): RunResult[] => {
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
      (pair.length === variants.length &&
        variants.every(
          (variant) =>
            pair.filter((other) => other.variant === variant).length === 1,
        ))
    )
  })
}

/**
 * Compare complete pairs only. Invalid or missing measurements cannot pass a
 * gate, and each status names whose measurement failed: an invalid candidate
 * fails qualification, while a baseline that cannot record a workload validly
 * is reported without ratios and does not hide the candidate's own result.
 */
const groupWorkloads = (runs: RunResult[]) => {
  const groups = new Map<string, RunResult[]>()
  for (const run of runs.filter((run) => !run.soak)) {
    const key = `${run.cpus}cpu-${run.workers}worker-${run.retain}`
    groups.set(key, [...(groups.get(key) ?? []), run])
  }
  return groups
}

/** The sorted pair numbers, when every pair has exactly one of each variant. */
const presentPairs = (
  observations: RunResult[],
  variants: readonly RunResult['variant'][],
  requiredPairs: number,
): number[] | undefined => {
  const pairs = [...new Set(observations.map((run) => run.pair))].sort(
    (left, right) => left - right,
  )
  const present =
    pairs.length === requiredPairs &&
    pairs.every((pair) =>
      variants.every(
        (variant) =>
          observations.filter(
            (run) => run.pair === pair && run.variant === variant,
          ).length === 1,
      ),
    )
  return present ? pairs : undefined
}

export const compareRuns = (runs: RunResult[], requiredPairs = 5) => {
  return [...groupWorkloads(runs)].map(([workload, observations]) => {
    const pairs = presentPairs(observations, VARIANTS, requiredPairs)
    if (!pairs) {
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
  comparisons: readonly Readonly<{ status: string }>[],
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

/** Nearest-rank percentile of finite observations. */
export const percentile = (values: number[], fraction: number): number => {
  if (!values.length || values.some((value) => !Number.isFinite(value))) {
    throw new Error('A percentile needs finite observations')
  }
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(
    sorted.length,
    Math.max(1, Math.ceil(fraction * sorted.length)),
  )
  return sorted[rank - 1] as number
}

export interface SwitchingBudget {
  readonly crossingP50Ms?: number
  readonly crossingP95Ms: number
  readonly sameTabMs: number
}

/**
 * Written before the first 2.0 measurement: milliseconds a recorded run adds
 * to each tab crossing and to a same-tab command, compared with recording off.
 */
export const SWITCHING_BUDGETS: Readonly<Record<string, SwitchingBudget>> = {
  '2cpu-2worker-all': {
    crossingP50Ms: 600,
    crossingP95Ms: 1_000,
    sameTabMs: 20,
  },
  '2cpu-4worker-all': { crossingP95Ms: 2_000, sameTabMs: 20 },
}

/**
 * Pools every candidate crossing, each less its pair's median recording-off
 * crossing, so a slow pair cannot hide behind a median of medians.
 */
export const compareSwitching = (runs: RunResult[], requiredPairs = 5) => {
  return [...groupWorkloads(runs)].map(([workload, observations]) => {
    const pairs = presentPairs(observations, SWITCHING_VARIANTS, requiredPairs)
    if (!pairs) {
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
    const controlInvalid = invalid('off')
    if (controlInvalid.length) {
      return {
        workload,
        status: 'incomplete' as const,
        invalid: controlInvalid,
      }
    }
    const crossing: number[] = []
    const sameTab: number[] = []
    const overhead: number[] = []
    for (const pair of pairs) {
      const pick = (variant: RunResult['variant']) =>
        observations.find(
          (run) => run.pair === pair && run.variant === variant,
        ) as RunResult
      const off = pick('off')
      const candidate = pick('candidate')
      if (!off.switching || !candidate.switching || off.suiteMs <= 0) {
        throw new Error(`Missing switch timings in ${workload} pair ${pair}`)
      }
      const offCrossing = median(off.switching.crossingMs)
      crossing.push(
        ...candidate.switching.crossingMs.map((ms) => ms - offCrossing),
      )
      sameTab.push(
        median(candidate.switching.sameTabMs) - median(off.switching.sameTabMs),
      )
      overhead.push(candidate.suiteMs / off.suiteMs - 1)
    }
    const budget = SWITCHING_BUDGETS[workload]
    const crossingP50Ms = percentile(crossing, 0.5)
    const crossingP95Ms = percentile(crossing, 0.95)
    const sameTabMs = median(sameTab)
    const withinBudget =
      budget !== undefined &&
      crossingP95Ms <= budget.crossingP95Ms &&
      (budget.crossingP50Ms === undefined ||
        crossingP50Ms <= budget.crossingP50Ms) &&
      sameTabMs <= budget.sameTabMs
    return {
      workload,
      status: withinBudget ? ('pass' as const) : ('investigate' as const),
      ...(budget ? { budget } : {}),
      crossings: crossing.length,
      crossingP50Ms,
      crossingP95Ms,
      sameTabMs,
      candidateOverhead: median(overhead),
    }
  })
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
