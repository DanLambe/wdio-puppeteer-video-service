import { executeHooksWithArgs } from '@wdio/utils'
import { describe, expect, it } from 'vitest'
import {
  ContextFollower,
  type ContextFollowerTarget,
  type FollowReason,
} from '../../src/service/context-follower.js'

// WDIO runs config and service command hooks through `executeHooksWithArgs`,
// which starts every hook body synchronously. These cases run the real
// follower through it, in both orders of WDIO's setup script in a new window
// and the getWindowHandles() result that lists that window.

interface Move {
  readonly contextId: string
  readonly reason: FollowReason
}

const createHarness = () => {
  const events: string[] = []
  const moves: Move[] = []
  let recorded = 'A'
  const target: ContextFollowerTarget = {
    get recordedContextId() {
      return recorded
    },
    hasActiveCapture: true,
    async followContext(contextId, reason) {
      moves.push({ contextId, reason })
      recorded = contextId
    },
    async stopClosingContext() {},
    async recoverFailedClose() {},
    async resumeAfterClose() {},
  }
  const follower = new ContextFollower({
    getBrowser: () => ({
      async getWindowHandle() {
        events.push('read current window')
        return 'A'
      },
      async browsingContextGetTree() {
        return {
          contexts: [{ context: 'A' }, { context: 'B' }, { context: 'C' }],
        }
      },
    }),
    log() {},
    target,
  })
  const serviceBefore = async (name: string, args: unknown[]) => {
    await follower.beforeCommand(name, args)
  }
  const serviceAfter = async (
    name: string,
    args: unknown[],
    result: unknown,
    error: unknown,
  ) => {
    await follower.afterCommand(name, args, result, error)
  }
  const before = async (
    name: string,
    args: unknown[],
    configHook: () => void = () => {},
  ) => {
    const results = await executeHooksWithArgs(
      'beforeCommand',
      [configHook, serviceBefore],
      [name, args],
    )
    expect(results.filter((result) => result instanceof Error)).toEqual([])
  }
  const after = async (name: string, result: unknown) => {
    const results = await executeHooksWithArgs(
      'afterCommand',
      [serviceAfter],
      [name, [], result, undefined],
    )
    expect(results.filter((result) => result instanceof Error)).toEqual([])
  }
  return { after, before, events, moves }
}

// WDIO's polyfill install in a window a page has just opened.
const setupScript = [
  {
    functionDeclaration: 'function webdriverioPolyfill() {}',
    target: { context: 'B', originalOpener: 'A', parent: null },
    awaitPromise: false,
  },
]

describe('ContextFollower under WDIO hook execution', () => {
  it('ignores the setup script when the handle list was recorded first', async () => {
    const harness = createHarness()

    await harness.after('getWindowHandles', ['A', 'B'])
    await harness.before('scriptCallFunction', setupScript)

    expect(harness.moves).toEqual([])

    // The test's own switch is what moves recording.
    await harness.before('switchToWindow', ['B'])
    expect(harness.moves).toEqual([
      { contextId: 'B', reason: 'switch-to-window' },
    ])
  })

  it('ignores the setup script when the handle list arrives while its hook runs', async () => {
    const harness = createHarness()
    let listed: Promise<void> | undefined

    await harness.before('scriptCallFunction', setupScript, () => {
      harness.events.push('config hook')
      queueMicrotask(() => {
        harness.events.push('handle list')
        listed = harness.after('getWindowHandles', ['A', 'B'])
      })
    })
    await listed
    await harness.after('getWindowHandles', ['A', 'B'])

    expect(harness.events).toEqual([
      'config hook',
      'read current window',
      'handle list',
    ])
    expect(harness.moves).toEqual([])

    await harness.before('switchToWindow', ['B'])
    expect(harness.moves).toEqual([
      { contextId: 'B', reason: 'switch-to-window' },
    ])
  })

  it('still follows scripts in a window from newWindow()', async () => {
    const harness = createHarness()

    await harness.after('newWindow', { contextId: 'C' })
    await harness.before('scriptCallFunction', [
      { target: { context: 'C' }, awaitPromise: true },
    ])

    expect(harness.moves).toEqual([{ contextId: 'C', reason: 'command' }])
  })
})
