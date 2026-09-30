import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { WorkerMetrics } from './statistics.js'

let metrics: WorkerMetrics
let startedAt = 0
let timer: NodeJS.Timeout | undefined
const histogram = monitorEventLoopDelay({ resolution: 20 })

const sample = () => {
  const memory = process.memoryUsage()
  metrics.samples.push({
    elapsedMs: performance.now() - startedAt,
    rssBytes: memory.rss,
    heapBytes: memory.heapUsed,
  })
  metrics.peakRssBytes = Math.max(metrics.peakRssBytes, memory.rss)
}

export const timeHook = async (
  kind: 'startupMs' | 'stopMs',
  operation: () => Promise<void>,
) => {
  const start = performance.now()
  try {
    await operation()
  } finally {
    metrics[kind].push(performance.now() - start)
    sample()
  }
}

export default class MetricsService {
  beforeSession(
    _config: unknown,
    _capabilities: unknown,
    _specs: string[],
    cid: string,
  ) {
    metrics = {
      cid,
      samples: [],
      peakRssBytes: 0,
      startupMs: [],
      stopMs: [],
      passed: 0,
      failed: 0,
      eventLoop: { meanMs: 0, p95Ms: 0, maxMs: 0 },
    }
    startedAt = performance.now()
    histogram.enable()
    sample()
    timer = setInterval(sample, 200)
    timer.unref()
  }

  afterTest(_test: unknown, _context: unknown, result: { passed: boolean }) {
    metrics[result.passed ? 'passed' : 'failed'] += 1
  }

  afterSession() {
    clearInterval(timer)
    sample()
    histogram.disable()
    metrics.eventLoop = {
      meanMs: histogram.mean / 1e6,
      p95Ms: histogram.percentile(95) / 1e6,
      maxMs: histogram.max / 1e6,
    }
    writeFileSync(
      path.join(
        process.env.PIPELINE_RUN_DIR as string,
        `worker-${metrics.cid}.json`,
      ),
      JSON.stringify(metrics),
    )
  }
}
