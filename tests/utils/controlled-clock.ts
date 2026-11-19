import {
  type ClockBoundary,
  systemClock,
} from '../../src/service/boundaries.js'

/**
 * A clock whose timers fire only when a test advances it, so a budget or a
 * wait limit never depends on wall time. Timers due together fire in the
 * order they were set.
 */
export const createControlledClock = () => {
  let elapsed = 0
  let nextTimer = 0
  const timers = new Map<number, { callback: () => void; due: number }>()
  const clock: ClockBoundary = {
    ...systemClock,
    clearTimeout(timer) {
      timers.delete((timer as unknown as { id: number }).id)
    },
    now: () => elapsed,
    setTimeout(callback, milliseconds) {
      nextTimer += 1
      timers.set(nextTimer, { callback, due: elapsed + milliseconds })
      return { id: nextTimer, unref() {} } as unknown as NodeJS.Timeout
    },
  }
  return {
    advance(milliseconds: number): void {
      elapsed += milliseconds
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.due <= elapsed)
        .sort(([, left], [, right]) => left.due - right.due)
      for (const [id, timer] of due) {
        if (timers.delete(id)) {
          timer.callback()
        }
      }
    },
    clock,
    pendingTimers: (): number => timers.size,
  }
}
