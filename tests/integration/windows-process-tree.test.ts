import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { nodeProcess } from '../../src/service/boundaries.js'
import { terminateFfmpegProcessTree } from '../../src/service/process-supervisor.js'

// Two test-owned Node processes stand in for an FFmpeg process and descendant.
// Both self-expire even if startup or test cleanup fails. No browser or FFmpeg
// installation is needed to exercise the real hidden Windows taskkill helper.
const parentProgram = `
const { spawn } = require('node:child_process')
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
  stdio: 'ignore', windowsHide: true
})
child.once('spawn', () => process.send(child.pid))
child.once('error', () => process.exit(1))
setTimeout(() => process.exit(0), 20000)
`

it.runIf(process.platform === 'win32')(
  'terminates a real Windows process tree, including its live descendant',
  async () => {
    const parent = spawn(
      process.execPath,
      ['--input-type=commonjs', '-e', parentProgram],
      {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
      },
    )
    let descendantPid: number | undefined
    try {
      const [message] = await once(parent, 'message', {
        signal: AbortSignal.timeout(8_000),
      })
      expect(typeof message).toBe('number')
      descendantPid = message as number
      expect(Number.isSafeInteger(descendantPid)).toBe(true)
      expect(descendantPid).toBeGreaterThan(0)
      expect(nodeProcess.isAlive(descendantPid)).toBe(true)
      const closed = once(parent, 'close', {
        signal: AbortSignal.timeout(8_000),
      })

      await terminateFfmpegProcessTree(parent, true)
      await closed

      expect(parent.exitCode !== null || parent.signalCode !== null).toBe(true)
      await expect
        .poll(() => nodeProcess.isAlive(descendantPid ?? 0), { timeout: 3_000 })
        .toBe(false)
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) {
        await terminateFfmpegProcessTree(parent, true)
      }
      if (descendantPid && nodeProcess.isAlive(descendantPid)) {
        try {
          process.kill(descendantPid, 'SIGKILL')
        } catch {
          // The test-owned child may have exited between the check and cleanup.
        }
      }
      if (parent.connected) {
        parent.disconnect()
      }
    }
  },
  20_000,
)
