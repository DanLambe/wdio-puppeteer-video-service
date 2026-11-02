import { AsyncLocalStorage } from 'node:async_hooks'
import { setCommandHookStore, wrapCommand } from '@wdio/utils'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ContextFollower,
  type ContextFollowerBrowser,
  type ContextFollowerTarget,
  type FollowReason,
} from '../../src/service/context-follower.js'
import {
  isInternalOperation,
  runInternal,
} from '../../src/service/internal-operation.js'

interface TargetHarness extends ContextFollowerTarget {
  readonly calls: string[]
  capture: boolean
  recorded: string | undefined
}

const createTarget = (recorded = 'tab-a'): TargetHarness => {
  const target: TargetHarness = {
    calls: [],
    capture: true,
    recorded,
    get recordedContextId() {
      return target.recorded
    },
    get hasActiveCapture() {
      return target.capture
    },
    followContext: vi.fn(async (contextId: string, reason: FollowReason) => {
      target.calls.push(`follow:${contextId}:${reason}`)
      target.recorded = contextId
      target.capture = true
    }),
    stopClosingContext: vi.fn(async (contextId: string) => {
      target.calls.push(`stop:${contextId}`)
      target.capture = false
    }),
    recoverFailedClose: vi.fn(async (contextId: string) => {
      target.calls.push(`recover:${contextId}`)
      target.capture = true
    }),
    resumeAfterClose: vi.fn(async () => {
      target.calls.push('resume')
    }),
  }
  return target
}

// tab-a holds frame-a1; tab-b is a second top-level tab.
const tree = {
  contexts: [
    { context: 'tab-a', children: [{ context: 'frame-a1', children: [] }] },
    { context: 'tab-b', children: null },
  ],
}

const createBrowser = (current = 'tab-a') => {
  const browser = {
    browsingContextGetTree: vi.fn(async () => tree),
    getWindowHandle: vi.fn(async () => current),
  } satisfies ContextFollowerBrowser
  return browser
}

const createFollower = (
  target: ContextFollowerTarget,
  browser: ContextFollowerBrowser | undefined = createBrowser(),
) => {
  const log = vi.fn()
  return {
    follower: new ContextFollower({
      getBrowser: () => browser,
      log,
      target,
    }),
    log,
  }
}

describe('ContextFollower', () => {
  it('follows a context the test was given, before its command runs', async () => {
    const target = createTarget()
    const { follower } = createFollower(target)

    await follower.afterCommand(
      'newWindow',
      [],
      { contextId: 'tab-b' },
      undefined,
    )
    await follower.beforeCommand('browsingContextLocateNodes', [
      { context: 'tab-b' },
    ])

    expect(target.calls).toEqual(['follow:tab-b:command'])
  })

  it('ignores background setup of a frame the test has not been given', async () => {
    const target = createTarget('tab-b')
    const browser = createBrowser()
    const { follower } = createFollower(target, browser)
    await follower.afterCommand('url', [], { contextId: 'tab-a' }, undefined)

    // WDIO's polyfill runs in a page's new iframe with no preload command.
    await follower.beforeCommand('scriptCallFunction', [
      { target: { context: 'frame-a1', parent: 'tab-a' } },
    ])

    expect(target.calls).toEqual([])
    expect(browser.browsingContextGetTree).not.toHaveBeenCalled()
  })

  it('follows a frame the test was given, as the tab that holds it', async () => {
    const target = createTarget('tab-b')
    const { follower } = createFollower(target)
    await follower.afterCommand(
      'frame',
      [],
      { contextId: 'frame-a1' },
      undefined,
    )

    await follower.beforeCommand('elementClick', ['f.frame-a1.d.DOC.e.3'])

    expect(target.calls).toEqual(['follow:tab-a:command'])
  })

  it('does not let concurrent preload activity hide a test command', async () => {
    const target = createTarget()
    const { follower } = createFollower(target)
    await follower.afterCommand(
      'newWindow',
      [],
      { contextId: 'tab-b' },
      undefined,
    )

    await follower.beforeCommand('scriptAddPreloadScript', [
      { contexts: ['tab-b'] },
    ])
    await follower.beforeCommand('scriptCallFunction', [
      { target: { context: 'tab-b' } },
    ])

    expect(target.calls).toEqual(['follow:tab-b:command'])
  })

  it('sends element-free Classic actions to the current window', async () => {
    const target = createTarget('tab-b')
    const browser = createBrowser('tab-a')
    const { follower } = createFollower(target, browser)

    await follower.beforeCommand('performActions', [[]])
    await follower.beforeCommand('performActions', [[]])

    expect(target.calls).toEqual(['follow:tab-a:command'])
    // The current window is read once, then kept from switchToWindow.
    expect(browser.getWindowHandle).toHaveBeenCalledOnce()
  })

  it('tracks the current window through switchToWindow and closes', async () => {
    const target = createTarget()
    const browser = createBrowser('tab-a')
    const { follower } = createFollower(target, browser)

    await follower.beforeCommand('switchToWindow', ['tab-b'])
    target.calls.length = 0
    await follower.beforeCommand('performActions', [[]])
    expect(target.calls).toEqual([])
    expect(browser.getWindowHandle).not.toHaveBeenCalled()

    await follower.afterCommand('closeWindow', [], null, undefined)
    await follower.beforeCommand('performActions', [[]])
    expect(browser.getWindowHandle).toHaveBeenCalledOnce()
  })

  it('records switchToWindow as the reason for a switch', async () => {
    const target = createTarget()
    const { follower } = createFollower(target)

    await follower.beforeCommand('switchToWindow', ['tab-b'])

    expect(target.calls).toEqual(['follow:tab-b:switch-to-window'])
  })

  it('leaves recording alone when the test switches to a window that does not exist', async () => {
    const target = createTarget()
    const browser = createBrowser('tab-a')
    const { follower } = createFollower(target, browser)

    await follower.beforeCommand('switchToWindow', ['no-such-window'])
    await follower.afterCommand(
      'switchToWindow',
      ['no-such-window'],
      undefined,
      new Error('no such window'),
    )
    await follower.beforeCommand('performActions', [[]])
    // The rejected handle is not addressable afterwards.
    await follower.beforeCommand('browsingContextLocateNodes', [
      { context: 'no-such-window' },
    ])

    expect(target.calls).toEqual([])
    expect(browser.getWindowHandle).toHaveBeenCalledOnce()
    expect(target.recorded).toBe('tab-a')
  })

  it('returns to the current window when the browser rejects a switch to a closed one', async () => {
    const target = createTarget()
    const browser = createBrowser('tab-a')
    const { follower } = createFollower(target, browser)
    // tab-b is in the cached tree, but has closed by the time of the switch.
    await follower.beforeCommand('switchToWindow', ['tab-a'])
    await follower.afterCommand('switchToWindow', ['tab-a'], null, undefined)
    target.calls.length = 0

    await follower.beforeCommand('switchToWindow', ['tab-b'])
    target.capture = false
    browser.browsingContextGetTree.mockResolvedValue({
      contexts: [{ context: 'tab-a', children: [] }],
    })
    await follower.afterCommand(
      'switchToWindow',
      ['tab-b'],
      undefined,
      new Error('no such window'),
    )
    // Later implicit actions follow the window the browser kept.
    await follower.beforeCommand('performActions', [[]])
    await follower.beforeCommand('switchToWindow', ['tab-b'])

    expect(target.calls).toEqual([
      'follow:tab-b:switch-to-window',
      'follow:tab-a:switch-failed',
    ])
    expect(target.recorded).toBe('tab-a')
    expect(browser.getWindowHandle).toHaveBeenCalledOnce()
  })

  it('keeps a valid switch working after a rejected one', async () => {
    const target = createTarget()
    const { follower } = createFollower(target)

    await follower.beforeCommand('switchToWindow', ['no-such-window'])
    await follower.afterCommand(
      'switchToWindow',
      ['no-such-window'],
      undefined,
      new Error('no such window'),
    )
    await follower.beforeCommand('switchToWindow', ['tab-b'])
    await follower.afterCommand('switchToWindow', ['tab-b'], null, undefined)
    await follower.beforeCommand('performActions', [[]])

    expect(target.calls).toEqual(['follow:tab-b:switch-to-window'])
  })

  it('records the followed tab again when its capture has stopped', async () => {
    const target = createTarget()
    target.capture = false
    const { follower } = createFollower(target)
    await follower.afterCommand('url', [], { contextId: 'tab-a' }, undefined)

    await follower.beforeCommand('browsingContextLocateNodes', [
      { context: 'tab-a' },
    ])

    expect(target.calls).toEqual(['follow:tab-a:command'])
  })

  it('leaves recording alone when the test asks to close a frame', async () => {
    const target = createTarget()
    const { follower } = createFollower(target)
    await follower.afterCommand(
      'frame',
      [],
      { contextId: 'frame-a1' },
      undefined,
    )

    await follower.beforeCommand('browsingContextClose', [
      { context: 'frame-a1' },
    ])
    await follower.afterCommand(
      'browsingContextClose',
      [{ context: 'frame-a1' }],
      undefined,
      new Error('Non top-level browsing context cannot be closed'),
    )

    expect(target.calls).toEqual(['recover:frame-a1'])
    expect(target.stopClosingContext).not.toHaveBeenCalled()
  })

  it('stops before closing the recorded tab and recovers if the close fails', async () => {
    const target = createTarget()
    const { follower } = createFollower(target)
    const close = [{ context: 'tab-a' }]

    await follower.beforeCommand('browsingContextClose', close)
    await follower.afterCommand(
      'browsingContextClose',
      close,
      undefined,
      new Error('refused'),
    )

    expect(target.calls).toEqual(['stop:tab-a', 'recover:tab-a'])
  })

  it('resumes once a close of the recorded tab succeeds', async () => {
    const target = createTarget()
    const { follower } = createFollower(target)
    const close = [{ context: 'tab-a' }]

    await follower.beforeCommand('switchToWindow', ['tab-a'])
    await follower.beforeCommand('browsingContextClose', close)
    await follower.afterCommand('browsingContextClose', close, null, undefined)
    await follower.afterCommand('closeWindow', [], null, undefined)

    expect(target.calls).toEqual(['stop:tab-a', 'resume', 'resume'])
  })

  it('does not stop when another tab closes', async () => {
    const target = createTarget()
    const { follower } = createFollower(target)
    await follower.afterCommand(
      'newWindow',
      [],
      { contextId: 'tab-b' },
      undefined,
    )

    await follower.beforeCommand('browsingContextClose', [{ context: 'tab-b' }])

    expect(target.stopClosingContext).not.toHaveBeenCalled()
  })

  it('ignores results of failed commands and contexts it cannot place', async () => {
    const target = createTarget()
    const browser = createBrowser()
    const { follower, log } = createFollower(target, browser)

    await follower.afterCommand(
      'newWindow',
      [],
      { contextId: 'tab-b' },
      new Error('x'),
    )
    await follower.beforeCommand('browsingContextLocateNodes', [
      { context: 'tab-b' },
    ])
    expect(target.calls).toEqual([])

    await follower.afterCommand('url', [], { contextId: 'gone' }, undefined)
    await follower.beforeCommand('browsingContextNavigate', [
      { context: 'gone' },
    ])
    expect(target.calls).toEqual([])

    browser.browsingContextGetTree.mockRejectedValueOnce(new Error('closed'))
    await follower.afterCommand('url', [], { contextId: 'tab-z' }, undefined)
    await follower.beforeCommand('browsingContextNavigate', [
      { context: 'tab-z' },
    ])
    expect(log).toHaveBeenCalledWith(
      'debug',
      expect.stringContaining('browsing context tree'),
    )
  })

  it('does nothing without a browser and reports an unreadable current window', async () => {
    const target = createTarget('tab-b')
    const { follower: detached } = createFollower(target, undefined)
    detached.reset()
    await detached.beforeCommand('performActions', [[]])
    await detached.beforeCommand('switchToWindow', ['tab-a'])
    target.calls.length = 0
    await detached.afterCommand(
      'frame',
      [],
      { contextId: 'frame-a1' },
      undefined,
    )
    await detached.beforeCommand('elementClick', ['f.frame-a1.d.D.e.1'])
    expect(target.calls).toEqual([])

    const browser = createBrowser()
    browser.getWindowHandle.mockRejectedValueOnce(new Error('no window'))
    const { follower, log } = createFollower(createTarget('tab-b'), browser)
    await follower.beforeCommand('performActions', [[]])
    expect(log).toHaveBeenCalledWith(
      'debug',
      expect.stringContaining("WDIO's current window"),
    )
  })
})

describe('ContextFollower inside WDIO command wrappers', () => {
  beforeAll(() => {
    // The WDIO runner installs an AsyncLocalStorage store for command hooks.
    setCommandHookStore(new AsyncLocalStorage<true>())
  })

  afterAll(() => {
    setCommandHookStore(new AsyncLocalStorage<true>())
  })

  const createClient = (follower: ContextFollower, events: string[]) => {
    const beforeCommand = async (name: string, args: unknown[]) => {
      if (isInternalOperation()) {
        return
      }
      events.push(`before:${name}`)
      await follower.beforeCommand(name, args)
    }
    const afterCommand = async (
      name: string,
      args: unknown[],
      result: unknown,
      error: unknown,
    ) => {
      if (isInternalOperation()) {
        return
      }
      await follower.afterCommand(name, args, result, error)
    }
    const client: Record<string, unknown> = {
      options: { beforeCommand: [beforeCommand], afterCommand: [afterCommand] },
    }
    client.performActions = wrapCommand(
      'performActions',
      async (): Promise<void> => {
        events.push('dispatch:performActions')
      },
    )
    client.keys = wrapCommand(
      'keys',
      async function (this: { performActions: (a: unknown) => unknown }) {
        await this.performActions([])
      },
    )
    client.getWindowHandle = wrapCommand(
      'getWindowHandle',
      async (): Promise<string> => {
        events.push('dispatch:getWindowHandle')
        return 'tab-a'
      },
    )
    client.browsingContextGetTree = wrapCommand(
      'browsingContextGetTree',
      async () => tree,
    )
    return client as unknown as ContextFollowerBrowser & {
      keys(value: string): Promise<void>
    }
  }

  it('switches on a nested Classic action before it is dispatched', async () => {
    const events: string[] = []
    const target = createTarget('tab-b')
    target.followContext = vi.fn(async (contextId: string) => {
      events.push(`follow:${contextId}`)
      target.recorded = contextId
    })
    let browser: ReturnType<typeof createClient> | undefined
    // The follower reads the browser late, as the service's does.
    const follower = new ContextFollower({
      getBrowser: () => browser,
      log: vi.fn(),
      target,
    })
    browser = createClient(follower, events)

    await browser.keys('x')

    expect(events).toEqual([
      'before:keys',
      'before:performActions',
      // The follower's own lookup runs inside the hook, so WDIO skips hooks.
      'dispatch:getWindowHandle',
      'follow:tab-a',
      'dispatch:performActions',
    ])
  })

  it('never feeds the service its own commands', async () => {
    const events: string[] = []
    const target = createTarget('tab-b')
    const { follower } = createFollower(target)
    const browser = createClient(follower, events)

    await runInternal(() => browser.keys('x'))

    expect(events).toEqual(['dispatch:performActions'])
    expect(target.followContext).not.toHaveBeenCalled()
  })
})
