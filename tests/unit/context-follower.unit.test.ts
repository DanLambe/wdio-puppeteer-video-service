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

  it('ignores a close of a context the test does not know', async () => {
    const target = createTarget()
    const browser = createBrowser()
    const { follower } = createFollower(target, browser)

    await follower.beforeCommand('browsingContextClose', [{ context: 'tab-q' }])

    expect(target.stopClosingContext).not.toHaveBeenCalled()
    expect(browser.browsingContextGetTree).not.toHaveBeenCalled()
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

const script = (context: string) => [
  { target: { context }, awaitPromise: false },
]

const enumerate = (
  follower: ContextFollower,
  handles: readonly string[] = ['tab-a', 'tab-b'],
) => follower.afterCommand('getWindowHandles', [], handles, undefined)

describe('ContextFollower with listed windows and scripts', () => {
  it.each(['scriptCallFunction', 'scriptEvaluate'])(
    'ignores %s in a window known only from getWindowHandles',
    async (command) => {
      const target = createTarget()
      const browser = createBrowser('tab-a')
      const { follower } = createFollower(target, browser)

      await enumerate(follower)
      await follower.beforeCommand(command, script('tab-b'))

      // No move, so the controller never brings tab-b to the front.
      expect(target.calls).toEqual([])
      expect(browser.browsingContextGetTree).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['empty', false],
    ['filled', true],
  ])(
    'ignores the script when the handle list arrives just after its hook starts (current-window cache %s)',
    async (_label, cached) => {
      const target = createTarget()
      const browser = createBrowser('tab-a')
      const { follower } = createFollower(target, browser)
      if (cached) {
        await follower.afterCommand('getWindowHandle', [], 'tab-a', undefined)
      }

      let listed: Promise<void> | undefined
      queueMicrotask(() => {
        listed = enumerate(follower)
      })
      await follower.beforeCommand('scriptCallFunction', script('tab-b'))
      await listed
      // Nothing reconsiders the ignored script, and a later list changes nothing.
      await enumerate(follower)
      await follower.beforeCommand('scriptCallFunction', script('tab-b'))

      expect(target.calls).toEqual([])
    },
  )

  it('follows an explicit switch to a listed window before the switch', async () => {
    const target = createTarget()
    const { follower } = createFollower(target)
    await enumerate(follower)

    await follower.beforeCommand('switchToWindow', ['tab-b'])
    expect(target.calls).toEqual(['follow:tab-b:switch-to-window'])
    await follower.afterCommand('switchToWindow', ['tab-b'], null, undefined)

    // tab-b is now addressable: its scripts follow once recording is elsewhere.
    await follower.beforeCommand('switchToWindow', ['tab-a'])
    await follower.afterCommand('switchToWindow', ['tab-a'], null, undefined)
    await follower.beforeCommand('scriptCallFunction', script('tab-b'))

    expect(target.calls).toEqual([
      'follow:tab-b:switch-to-window',
      'follow:tab-a:switch-to-window',
      'follow:tab-b:command',
    ])
  })

  it.each([
    ['browsingContextNavigate', [{ context: 'tab-b', url: '/next' }]],
    ['browsingContextLocateNodes', [{ context: 'tab-b' }]],
    ['inputPerformActions', [{ context: 'tab-b', actions: [] }]],
    ['elementClick', ['f.tab-b.d.DOC.e.1']],
  ] as const)(
    'follows %s on a listed window and then trusts its scripts',
    async (command, args) => {
      const target = createTarget()
      const browser = createBrowser('tab-a')
      const { follower } = createFollower(target, browser)
      await enumerate(follower)

      await follower.beforeCommand(command, args)
      expect(target.calls).toEqual(['follow:tab-b:command'])

      // Recording returns to tab-a; a script on the promoted tab-b follows.
      await follower.beforeCommand('browsingContextLocateNodes', [
        { context: 'tab-a' },
      ])
      await follower.beforeCommand('scriptCallFunction', script('tab-b'))

      expect(target.calls).toEqual([
        'follow:tab-b:command',
        'follow:tab-a:command',
        'follow:tab-b:command',
      ])
    },
  )

  it.each([
    ['newWindow', { contextId: 'tab-b' }, 'tab-b', 'tab-b'],
    ['url', { contextId: 'tab-b' }, 'tab-b', 'tab-b'],
    ['frame', { contextId: 'frame-a1' }, 'frame-a1', 'tab-a'],
    [
      'browsingContexts',
      [{ contextId: 'tab-a' }, { contextId: 'tab-b' }],
      'tab-b',
      'tab-b',
    ],
    ['browsingContextCreate', { context: 'tab-b' }, 'tab-b', 'tab-b'],
  ] as const)(
    'follows scripts and element commands in a context from %s',
    async (command, result, context, tab) => {
      const target = createTarget('tab-z')
      const { follower } = createFollower(target)
      await follower.afterCommand(command, [], result, undefined)

      await follower.beforeCommand('scriptCallFunction', script(context))
      target.recorded = 'tab-z'
      await follower.beforeCommand('elementClick', [`f.${context}.d.DOC.e.1`])

      expect(target.calls).toEqual([
        `follow:${tab}:command`,
        `follow:${tab}:command`,
      ])
    },
  )

  it('does not downgrade a held context that a later handle list contains', async () => {
    const target = createTarget()
    const { follower } = createFollower(target)
    await follower.afterCommand(
      'newWindow',
      [],
      { contextId: 'tab-b' },
      undefined,
    )

    await enumerate(follower)
    await follower.beforeCommand('scriptCallFunction', script('tab-b'))

    expect(target.calls).toEqual(['follow:tab-b:command'])
  })

  it.each([
    ['listed', ['tab-a', 'tab-b']],
    ['never listed', []],
  ] as const)(
    'returns root execute to the current window after a held tab (current window %s)',
    async (_label, handles) => {
      const target = createTarget()
      const browser = createBrowser('tab-a')
      const { follower } = createFollower(target, browser)
      await enumerate(follower, handles)
      await follower.afterCommand(
        'newWindow',
        [],
        { contextId: 'tab-b' },
        undefined,
      )
      await follower.beforeCommand('elementClick', ['f.tab-b.d.DOC.e.1'])

      // BiDi `browser.execute()` is a scriptCallFunction on the current window.
      await follower.beforeCommand('scriptCallFunction', script('tab-a'))

      expect(target.calls).toEqual([
        'follow:tab-b:command',
        'follow:tab-a:command',
      ])
      expect(browser.getWindowHandle).toHaveBeenCalledOnce()
    },
  )

  it('treats a getWindowHandle result as the current, addressable window', async () => {
    const target = createTarget('tab-b')
    const browser = createBrowser('tab-a')
    const { follower } = createFollower(target, browser)

    await follower.afterCommand('getWindowHandle', [], 'tab-a', undefined)
    await follower.beforeCommand('scriptCallFunction', script('tab-a'))
    target.recorded = 'tab-b'
    await follower.beforeCommand('performActions', [[]])

    expect(target.calls).toEqual([
      'follow:tab-a:command',
      'follow:tab-a:command',
    ])
    // Both decisions used the result; the browser was not asked again.
    expect(browser.getWindowHandle).not.toHaveBeenCalled()
  })

  it('restores a listed window, the current window and capture after a rejected switch', async () => {
    const target = createTarget()
    const browser = createBrowser('tab-a')
    const { follower } = createFollower(target, browser)
    await enumerate(follower)

    await follower.beforeCommand('switchToWindow', ['tab-b'])
    target.capture = false
    await follower.afterCommand(
      'switchToWindow',
      ['tab-b'],
      undefined,
      new Error('no such window'),
    )
    expect(target.calls).toEqual([
      'follow:tab-b:switch-to-window',
      'follow:tab-a:switch-failed',
    ])

    // tab-b is listed again, not addressable: a script there is ignored.
    await follower.beforeCommand('scriptCallFunction', script('tab-b'))
    // The current window is tab-a again, without another read.
    await follower.beforeCommand('performActions', [[]])
    expect(browser.getWindowHandle).toHaveBeenCalledOnce()
    // Still known as listed, so the test's own command on it follows.
    await follower.beforeCommand('browsingContextLocateNodes', [
      { context: 'tab-b' },
    ])

    expect(target.calls).toEqual([
      'follow:tab-b:switch-to-window',
      'follow:tab-a:switch-failed',
      'follow:tab-b:command',
    ])
  })

  it.each([
    ['unknown', undefined, []],
    ['held', 'newWindow', ['follow:tab-b:command']],
  ] as const)(
    'restores an %s window after a rejected switch',
    async (_label, source, expected) => {
      const target = createTarget()
      const { follower } = createFollower(target)
      if (source) {
        await follower.afterCommand(
          source,
          [],
          { contextId: 'tab-b' },
          undefined,
        )
      }

      await follower.beforeCommand('switchToWindow', ['tab-b'])
      await follower.afterCommand(
        'switchToWindow',
        ['tab-b'],
        undefined,
        new Error('no such window'),
      )
      target.calls.length = 0
      await follower.beforeCommand('scriptCallFunction', script('tab-b'))
      await follower.beforeCommand('browsingContextLocateNodes', [
        { context: 'tab-b' },
      ])

      expect(target.calls).toEqual(expected)
    },
  )

  it('logs each decision at trace level', async () => {
    const target = createTarget()
    const { follower, log } = createFollower(target, createBrowser('tab-a'))
    await enumerate(follower)

    await follower.beforeCommand('scriptCallFunction', script('tab-b'))
    await follower.beforeCommand('browsingContextNavigate', [
      { context: 'tab-b' },
    ])
    await follower.beforeCommand('browsingContextNavigate', [
      { context: 'tab-q' },
    ])
    await follower.beforeCommand('switchToWindow', ['tab-q'])

    const lines = log.mock.calls
      .filter(([level]) => level === 'trace')
      .map(([, message]) => message)
    expect(lines).toEqual([
      expect.stringContaining(
        '#1: scriptCallFunction on tab-b (enumerated), recorded tab-a, current tab-a: ignored: script on a context the test has not addressed.',
      ),
      expect.stringContaining(
        '#2: browsingContextNavigate on tab-b (enumerated), recorded tab-a, current tab-a: follow tab-b (command).',
      ),
      expect.stringContaining(
        '#3: browsingContextNavigate on tab-q (unknown), recorded tab-b, current tab-a: ignored: unknown context.',
      ),
      expect.stringContaining(
        '#4: switchToWindow on tab-q (unknown), recorded tab-b, current tab-a: ignored: not an open window.',
      ),
    ])
  })

  it('ignores a known context that is no longer in the tree', async () => {
    const target = createTarget()
    const browser = createBrowser('tab-a')
    const { follower, log } = createFollower(target, browser)
    await enumerate(follower, ['tab-a', 'tab-gone'])

    await follower.beforeCommand('browsingContextNavigate', [
      { context: 'tab-gone' },
    ])

    expect(target.calls).toEqual([])
    expect(log).toHaveBeenCalledWith(
      'trace',
      expect.stringContaining('ignored: not in the tree'),
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

// A closed tab must not stay known as an open window: a switch to it would
// end the recorded tab's segment for a tab that can no longer be filmed.
describe('ContextFollower after a tab closes', () => {
  const createClosingBrowser = () => {
    let open = ['tab-a', 'tab-b']
    const browser = {
      browsingContextGetTree: vi.fn(async () => ({
        contexts: open.map((context) =>
          context === 'tab-b'
            ? { context, children: [{ context: 'frame-b1', children: [] }] }
            : { context, children: [] },
        ),
      })),
      getWindowHandle: vi.fn(async () => 'tab-a'),
    } satisfies ContextFollowerBrowser
    return {
      browser,
      close: (context: string) => {
        open = open.filter((candidate) => candidate !== context)
      },
    }
  }

  const visitTabB = async (follower: ContextFollower) => {
    await follower.afterCommand(
      'getWindowHandles',
      [],
      ['tab-a', 'tab-b'],
      undefined,
    )
    await follower.beforeCommand('switchToWindow', ['tab-b'])
    await follower.afterCommand('switchToWindow', ['tab-b'], null, undefined)
    await follower.afterCommand(
      'frame',
      [],
      { contextId: 'frame-b1' },
      undefined,
    )
    await follower.beforeCommand('browsingContextLocateNodes', [
      { context: 'frame-b1' },
    ])
    await follower.beforeCommand('switchToWindow', ['tab-a'])
    await follower.afterCommand('switchToWindow', ['tab-a'], null, undefined)
  }

  it('does not follow a switch to a tab a BiDi close removed', async () => {
    const target = createTarget()
    const tabs = createClosingBrowser()
    const { follower } = createFollower(target, tabs.browser)
    await visitTabB(follower)
    target.calls.length = 0

    const close = [{ context: 'tab-b' }]
    await follower.beforeCommand('browsingContextClose', close)
    tabs.close('tab-b')
    await follower.afterCommand('browsingContextClose', close, null, undefined)
    await follower.beforeCommand('switchToWindow', ['tab-b'])

    expect(target.calls).toEqual(['resume'])
  })

  it('does not follow a frame of a tab a BiDi close removed', async () => {
    const target = createTarget()
    const tabs = createClosingBrowser()
    const { follower } = createFollower(target, tabs.browser)
    await visitTabB(follower)
    target.calls.length = 0

    const close = [{ context: 'tab-b' }]
    await follower.beforeCommand('browsingContextClose', close)
    tabs.close('tab-b')
    await follower.afterCommand('browsingContextClose', close, null, undefined)
    await follower.beforeCommand('browsingContextLocateNodes', [
      { context: 'frame-b1' },
    ])

    expect(target.calls).toEqual(['resume'])
  })

  it('does not follow a switch to a tab a Classic close removed', async () => {
    const target = createTarget()
    const tabs = createClosingBrowser()
    const { follower } = createFollower(target, tabs.browser)
    await visitTabB(follower)
    await follower.beforeCommand('switchToWindow', ['tab-b'])
    await follower.afterCommand('switchToWindow', ['tab-b'], null, undefined)
    target.calls.length = 0

    await follower.beforeCommand('closeWindow', [])
    tabs.close('tab-b')
    await follower.afterCommand('closeWindow', [], ['tab-a'], undefined)
    // The controller stopped the closed tab's capture, and WDIO has no current
    // window until the test switches.
    target.capture = false
    await follower.beforeCommand('switchToWindow', ['tab-b'])

    expect(target.calls).toEqual(['resume'])
  })

  it('still follows a tab that stays open after another closes', async () => {
    const target = createTarget('tab-b')
    const tabs = createClosingBrowser()
    const { follower } = createFollower(target, tabs.browser)
    await follower.afterCommand(
      'getWindowHandles',
      [],
      ['tab-a', 'tab-b'],
      undefined,
    )

    const close = [{ context: 'tab-b' }]
    await follower.beforeCommand('browsingContextClose', close)
    tabs.close('tab-b')
    await follower.afterCommand('browsingContextClose', close, null, undefined)
    target.calls.length = 0
    await follower.beforeCommand('switchToWindow', ['tab-a'])

    expect(target.calls).toEqual(['follow:tab-a:switch-to-window'])
  })
})
