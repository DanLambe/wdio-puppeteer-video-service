import type { ClockBoundary } from '../../src/service/boundaries.js'

interface RequestedDelay {
  readonly milliseconds: number
  readonly signal: AbortSignal | undefined
  readonly resolve: () => void
}

/**
 * `ClockBoundary.delay` for a test: each delay ends only when the test
 * expires it, or when its signal aborts, so a bounded wait never depends on
 * wall time. Every delay requested is kept for inspection.
 */
export const createControlledDelays = () => {
  const requested: RequestedDelay[] = []
  const delay: ClockBoundary['delay'] = (milliseconds, signal) => {
    const { promise, resolve } = Promise.withResolvers<void>()
    requested.push({ milliseconds, signal, resolve })
    signal?.addEventListener('abort', () => resolve(), { once: true })
    return promise
  }
  return {
    delay,
    /** Ends every delay requested so far, as if its time had passed. */
    expire(): void {
      for (const { resolve } of requested) {
        resolve()
      }
    },
    requested: requested as readonly RequestedDelay[],
  }
}
