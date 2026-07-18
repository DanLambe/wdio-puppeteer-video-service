import type { ChildProcess } from 'node:child_process'

const DEFAULT_CHILD_PROCESS_TIMEOUT_MS = 5 * 60_000

export const waitForChildProcess = async (
  child: ChildProcess,
  describeFailure: (code: number | null) => string,
  timeoutMs = DEFAULT_CHILD_PROCESS_TIMEOUT_MS,
  expectedExitCodes: readonly (number | null)[] = [0],
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let timeout: NodeJS.Timeout | undefined

    const settle = (error?: Error): void => {
      if (settled) {
        return
      }

      settled = true
      if (timeout) {
        clearTimeout(timeout)
      }

      if (error) {
        reject(error)
        return
      }

      resolve()
    }

    child.once('error', (error) => {
      settle(error)
    })

    child.once('close', (code) => {
      if (expectedExitCodes.includes(code)) {
        settle()
        return
      }

      settle(new Error(describeFailure(code)))
    })

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill()
        settle(
          new Error(
            `${describeFailure(null)} (timed out after ${timeoutMs.toString()}ms)`,
          ),
        )
      }, timeoutMs)
      timeout.unref()
    }
  })
}
