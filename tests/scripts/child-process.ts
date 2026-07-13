import type { ChildProcess } from 'node:child_process'

export const waitForChildProcess = async (
  child: ChildProcess,
  describeFailure: (code: number | null) => string,
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(describeFailure(code)))
    })
  })
}
