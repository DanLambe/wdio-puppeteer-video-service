import { describe, expect, it } from 'vitest'
import {
  ContextFollower,
  type ContextFollowerTarget,
  type FollowReason,
} from '../../src/service/context-follower.js'

// The follower reads WDIO's current window when its cache is empty, for
// example to decide whether a background script runs there. These cases hold
// that read open while the test switches, rolls back, closes a tab or resets,
// then let the old answer arrive. Only the window state after those changes may decide
// where an implicit Classic action (`browser.keys()`) is filmed.

interface RaceTarget extends ContextFollowerTarget {
  readonly calls: string[]
  recorded: string
  /** Holds the next switch follow open until `release` is called. */
  holdNextSwitch(): { readonly entered: Promise<void>; release(): void }
}

interface SwitchGate {
  readonly entered: PromiseWithResolvers<void>
  readonly release: PromiseWithResolvers<void>
}

const createTarget = (recorded: string): RaceTarget => {
  let held: SwitchGate | undefined
  const target: RaceTarget = {
    calls: [],
    recorded,
    get recordedContextId() {
      return target.recorded
    },
    hasActiveCapture: true,
    async followContext(contextId: string, reason: FollowReason) {
      target.calls.push(`follow:${contextId}:${reason}`)
      target.recorded = contextId
      const gate = reason === 'switch-to-window' ? held : undefined
      if (gate) {
        held = undefined
        gate.entered.resolve()
        await gate.release.promise
      }
    },
    async stopClosingContext() {},
    async recoverFailedClose() {},
    async resumeAfterClose() {},
    holdNextSwitch() {
      const gate: SwitchGate = {
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      }
      held = gate
      return {
        entered: gate.entered.promise,
        release: () => gate.release.resolve(),
      }
    },
  }
  return target
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Current-window reads the test answers one by one. */
const createWindowReads = () => {
  const pending: PromiseWithResolvers<string>[] = []
  return {
    pending,
    read(): Promise<string> {
      const answer = Promise.withResolvers<string>()
      pending.push(answer)
      return answer.promise
    },
    /** Lets pending hooks run until the expected read has been sent. */
    async started(count: number): Promise<void> {
      for (let turn = 0; turn < 10 && pending.length < count; turn += 1) {
        await settle()
      }
      expect(pending, 'current-window reads sent').toHaveLength(count)
    },
  }
}

const createRace = (recorded = 'tab-a') => {
  const target = createTarget(recorded)
  const reads = createWindowReads()
  const follower = new ContextFollower({
    getBrowser: () => ({
      async browsingContextGetTree() {
        return {
          contexts: ['tab-a', 'tab-b', 'tab-c', 'tab-d'].map((context) => ({
            context,
          })),
        }
      },
      getWindowHandle: () => reads.read(),
    }),
    log() {},
    target,
  })
  return { follower, reads, target }
}

const script = (context: string) => [
  { target: { context }, awaitPromise: false },
]

const listWindows = (follower: ContextFollower) =>
  follower.afterCommand(
    'getWindowHandles',
    [],
    ['tab-a', 'tab-b', 'tab-c', 'tab-d'],
    undefined,
  )

const switchSucceeded = (follower: ContextFollower, contextId: string) =>
  follower.afterCommand('switchToWindow', [contextId], null, undefined)

/** A BiDi close of a top-level context that the browser accepts. */
const closeTab = async (follower: ContextFollower, contextId: string) => {
  const args = [{ context: contextId }]
  await follower.beforeCommand('browsingContextClose', args)
  await follower.afterCommand('browsingContextClose', args, null, undefined)
}

describe('ContextFollower with a current-window read in flight', () => {
  it('stays on the switched-to tab when the read answers during the switch before-hook', async () => {
    const { follower, reads, target } = createRace()
    await listWindows(follower)
    const background = follower.beforeCommand(
      'scriptCallFunction',
      script('tab-c'),
    )
    await reads.started(1)

    const hold = target.holdNextSwitch()
    const switching = follower.beforeCommand('switchToWindow', ['tab-b'])
    await hold.entered
    // The browser has not switched yet, so tab-a is right at this instant.
    reads.pending[0]?.resolve('tab-a')
    await background
    hold.release()
    await switching
    await switchSucceeded(follower, 'tab-b')
    await follower.beforeCommand('performActions', [[]])

    expect(target.calls).toEqual(['follow:tab-b:switch-to-window'])
    expect(target.recorded).toBe('tab-b')
    // The action used the switch; the browser was not asked again.
    expect(reads.pending).toHaveLength(1)
  })

  it('does not let the old answer make its own script eligible', async () => {
    const { follower, reads, target } = createRace()
    await listWindows(follower)
    const background = follower.beforeCommand(
      'scriptCallFunction',
      script('tab-c'),
    )
    await reads.started(1)

    const hold = target.holdNextSwitch()
    const switching = follower.beforeCommand('switchToWindow', ['tab-b'])
    await hold.entered
    // WDIO was on tab-c when the read started; the test is now leaving it.
    reads.pending[0]?.resolve('tab-c')
    await background
    hold.release()
    await switching
    await switchSucceeded(follower, 'tab-b')
    await follower.beforeCommand('performActions', [[]])

    expect(target.calls).toEqual(['follow:tab-b:switch-to-window'])
    expect(target.recorded).toBe('tab-b')
  })

  it('stays on the switched-to tab when the read answers after the switch succeeded', async () => {
    const { follower, reads, target } = createRace()
    await listWindows(follower)
    const background = follower.beforeCommand(
      'scriptCallFunction',
      script('tab-c'),
    )
    await reads.started(1)

    await follower.beforeCommand('switchToWindow', ['tab-b'])
    await switchSucceeded(follower, 'tab-b')
    reads.pending[0]?.resolve('tab-a')
    await background
    await follower.beforeCommand('performActions', [[]])

    expect(target.calls).toEqual(['follow:tab-b:switch-to-window'])
    expect(target.recorded).toBe('tab-b')
  })

  it('follows the window that survives a rejected switch, not the old answer', async () => {
    const { follower, reads, target } = createRace()
    await listWindows(follower)
    const background = follower.beforeCommand(
      'scriptCallFunction',
      script('tab-c'),
    )
    await reads.started(1)
    await follower.beforeCommand('switchToWindow', ['tab-b'])
    await switchSucceeded(follower, 'tab-b')

    // tab-d closed before the switch reached the browser.
    await follower.beforeCommand('switchToWindow', ['tab-d'])
    const rejected = follower.afterCommand(
      'switchToWindow',
      ['tab-d'],
      undefined,
      new Error('no such window'),
    )
    await reads.started(2)
    reads.pending[1]?.resolve('tab-b')
    await rejected
    reads.pending[0]?.resolve('tab-a')
    await background
    await follower.beforeCommand('performActions', [[]])

    expect(target.calls).toEqual([
      'follow:tab-b:switch-to-window',
      'follow:tab-d:switch-to-window',
      'follow:tab-b:switch-failed',
    ])
    expect(target.recorded).toBe('tab-b')
    expect(reads.pending).toHaveLength(2)
  })

  it('does not carry an answer from before a reset into the next test', async () => {
    const { follower, reads, target } = createRace()
    await listWindows(follower)
    const background = follower.beforeCommand(
      'scriptCallFunction',
      script('tab-c'),
    )
    await reads.started(1)

    follower.reset()
    reads.pending[0]?.resolve('tab-a')
    await background
    // The next test's browser is on tab-b; its first implicit action reads it.
    const action = follower.beforeCommand('performActions', [[]])
    await reads.started(2)
    reads.pending[1]?.resolve('tab-b')
    await action

    expect(target.calls).toEqual(['follow:tab-b:command'])
    expect(target.recorded).toBe('tab-b')
  })

  it('does not film a tab that a BiDi close removed while the read was in flight', async () => {
    const { follower, reads, target } = createRace('tab-b')
    await listWindows(follower)
    const background = follower.beforeCommand(
      'scriptCallFunction',
      script('tab-c'),
    )
    await reads.started(1)

    await closeTab(follower, 'tab-a')
    // The browser answered while tab-a was still open.
    reads.pending[0]?.resolve('tab-a')
    await background
    // The next implicit action must ask again; the browser has no current
    // window now that tab-a is gone.
    const action = follower.beforeCommand('performActions', [[]])
    await settle()
    reads.pending[1]?.reject(new Error('no such window'))
    await action

    expect(target.calls).toEqual([])
    expect(target.recorded).toBe('tab-b')
    expect(reads.pending).toHaveLength(2)
  })

  it('keeps a known current window when a BiDi close removes another tab', async () => {
    const { follower, reads, target } = createRace('tab-b')
    await listWindows(follower)
    await follower.afterCommand('getWindowHandle', [], 'tab-b', undefined)

    await closeTab(follower, 'tab-a')
    await follower.beforeCommand('performActions', [[]])

    expect(target.calls).toEqual([])
    expect(target.recorded).toBe('tab-b')
    // The cached window still answered; the browser was not asked.
    expect(reads.pending).toHaveLength(0)
  })
})
