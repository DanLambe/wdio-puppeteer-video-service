import { type ChildProcess, spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { nodeProcess } from '../../src/service/boundaries.js'
import {
  FfmpegProcessRegistry,
  runFfmpeg,
} from '../../src/service/ffmpeg-runner.js'
import { terminateFfmpegProcessTree } from '../../src/service/process-supervisor.js'

// Two test-owned Node processes stand in for an FFmpeg process and the child a
// wrapper or custom executable can leave behind. The descendant must be
// `detached`: libuv otherwise places every spawned child in the spawning
// process's job object with `KILL_ON_JOB_CLOSE`, so Windows reaps it the moment
// the Node parent dies and the assertions below could not tell a process-tree
// kill from a single-process kill. FFmpeg is not a libuv process, so `detached`
// is what makes this fixture model the real subject. The descendant announces
// itself on stderr so the same fixture also works through the runner's own
// spawn boundary, and both processes self-expire even if startup or cleanup
// fails. No browser or FFmpeg installation is needed to exercise the real
// hidden taskkill helper.
const parentProgram = `
const { spawn } = require('node:child_process')
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
  stdio: 'ignore', windowsHide: true, detached: true
})
child.once('spawn', () => console.error('descendant ' + child.pid))
child.once('error', () => process.exit(1))
child.unref()
setTimeout(() => process.exit(0), 20000)
`

interface ProcessTree {
  readonly descendantPid: Promise<number>
  readonly parent: ChildProcess
}

const spawnProcessTree = (): ProcessTree => {
  const parent = spawn(
    process.execPath,
    ['--input-type=commonjs', '-e', parentProgram],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    },
  )
  const descendantPid = new Promise<number>((resolve, reject) => {
    const expiry = setTimeout(() => {
      reject(new Error('The fixture never reported a descendant process'))
    }, 10_000)
    parent.stderr?.on('data', (chunk: Buffer) => {
      const reported = /descendant (\d+)/.exec(chunk.toString('utf8'))?.[1]
      if (reported) {
        clearTimeout(expiry)
        resolve(Number(reported))
      }
    })
  })
  return { descendantPid, parent }
}

const reapProcessTree = async (
  tree: ProcessTree | undefined,
  descendantPid: number | undefined,
): Promise<void> => {
  if (
    tree &&
    tree.parent.exitCode === null &&
    tree.parent.signalCode === null
  ) {
    await terminateFfmpegProcessTree(tree.parent, true)
  }
  if (descendantPid !== undefined && nodeProcess.isAlive(descendantPid)) {
    try {
      process.kill(descendantPid, 'SIGKILL')
    } catch {
      // The test-owned child may have exited between the check and cleanup.
    }
  }
}

const expectTreeReaped = async (
  parent: ChildProcess,
  descendantPid: number,
): Promise<void> => {
  await expect
    .poll(() => parent.exitCode !== null || parent.signalCode !== null, {
      timeout: 5_000,
    })
    .toBe(true)
  await expect
    .poll(() => nodeProcess.isAlive(descendantPid), { timeout: 5_000 })
    .toBe(false)
}

const windowsIt = it.runIf(process.platform === 'win32')

windowsIt.each([
  { force: false, outcome: 'leaves the tree intact to escalate against' },
  { force: true, outcome: 'reaps the whole process tree' },
])(
  'real Windows termination with force=$force $outcome',
  async ({ force }) => {
    const tree = spawnProcessTree()
    let descendantPid: number | undefined
    try {
      const parentPid = tree.parent.pid as number
      descendantPid = await tree.descendantPid
      expect(nodeProcess.isAlive(parentPid)).toBe(true)
      expect(nodeProcess.isAlive(descendantPid)).toBe(true)

      await terminateFfmpegProcessTree(tree.parent, force)

      if (!force) {
        // `taskkill /T` cannot terminate a console process without `/F`, and
        // Windows has no graceful per-process signal to fall back to. Nothing
        // may die here: the forced pass still needs this parent to enumerate
        // the descendants it is about to reach. Exit codes surface a tick after
        // the process dies, so settle first and then assert the tree survived.
        await delay(500)
        expect(nodeProcess.isAlive(parentPid)).toBe(true)
        expect(nodeProcess.isAlive(descendantPid)).toBe(true)
        return
      }
      await expectTreeReaped(tree.parent, descendantPid)
    } finally {
      await reapProcessTree(tree, descendantPid)
    }
  },
  30_000,
)

windowsIt.each([
  { timeoutMs: 3_000, trigger: 'timeout' },
  { timeoutMs: 0, trigger: 'registry teardown' },
])(
  'the runner escalates $trigger to the whole process tree',
  async ({ timeoutMs, trigger }) => {
    const registry = new FfmpegProcessRegistry()
    const spawnFailures: string[] = []
    let tree: ProcessTree | undefined
    let descendantPid: number | undefined
    try {
      const completed = runFfmpeg(
        {
          args: [],
          available: true,
          ffmpegPath: 'process-tree-fixture',
          log: () => {},
          markUnavailable: () => spawnFailures.push('markUnavailable'),
          operation: 'process tree',
          timeoutMs,
          warnMissing: (reason) => spawnFailures.push(reason),
        },
        {
          processRegistry: registry,
          spawnProcess: () => {
            tree = spawnProcessTree()
            return tree.parent
          },
        },
      )
      expect(tree).toBeDefined()
      const started = tree as ProcessTree
      descendantPid = await started.descendantPid
      expect(registry.size).toBe(1)

      if (trigger !== 'timeout') {
        await registry.terminateAll()
      }

      await expect(completed).resolves.toBe(false)
      expect(spawnFailures).toEqual([])
      expect(registry.size).toBe(0)
      await expectTreeReaped(started.parent, descendantPid)
    } finally {
      await reapProcessTree(tree, descendantPid)
    }
  },
  30_000,
)
