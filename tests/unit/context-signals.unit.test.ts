import { describe, expect, it } from 'vitest'
import {
  classifyCommand,
  readIntroducedContexts,
} from '../../src/service/context-signals.js'

describe('WebDriver BiDi context signals', () => {
  it('reads the context of BiDi commands that drive a page', () => {
    expect(
      classifyCommand('browsingContextLocateNodes', [{ context: 'tab-a' }]),
    ).toEqual({ kind: 'drive', contextId: 'tab-a' })
    expect(
      classifyCommand('inputPerformActions', [{ context: 'tab-b' }]),
    ).toEqual({ kind: 'drive', contextId: 'tab-b' })
    expect(
      classifyCommand('scriptCallFunction', [{ target: { context: 'frame' } }]),
    ).toEqual({ kind: 'drive', contextId: 'frame' })
  })

  it('reads the navigable embedded in a shared element reference', () => {
    expect(classifyCommand('elementClick', ['f.TAB.d.DOC.e.7'])).toEqual({
      kind: 'drive',
      contextId: 'TAB',
    })
    expect(classifyCommand('getElementText', ['f.F1.d.D.e.1'])).toEqual({
      kind: 'drive',
      contextId: 'F1',
    })
    // A Classic element id carries no navigable.
    expect(classifyCommand('elementClick', ['abc-123'])).toBeUndefined()
  })

  it('treats element-free Classic actions as acting on the current window', () => {
    for (const name of ['performActions', 'releaseActions', 'navigateTo']) {
      expect(classifyCommand(name, [[]])).toEqual({ kind: 'current' })
    }
  })

  it('names switches and closes explicitly', () => {
    expect(classifyCommand('switchToWindow', ['tab-a'])).toEqual({
      kind: 'switch',
      contextId: 'tab-a',
    })
    expect(
      classifyCommand('browsingContextClose', [{ context: 'tab-a' }]),
    ).toEqual({ kind: 'close', contextId: 'tab-a' })
  })

  it('leaves reads, screenshots, prompts and missing contexts alone', () => {
    for (const [name, args] of [
      ['browsingContextCaptureScreenshot', [{ context: 'tab-a' }]],
      ['browsingContextHandleUserPrompt', [{ context: 'tab-a' }]],
      ['browsingContextGetTree', [{}]],
      ['takeElementScreenshot', ['f.TAB.d.DOC.e.7']],
      ['takeScreenshot', []],
      ['getTitle', []],
      ['back', []],
      ['closeWindow', []],
      ['browsingContextNavigate', [{}]],
      ['scriptCallFunction', [{ target: { realm: 'r' } }]],
      ['switchToWindow', [undefined]],
      ['browsingContextClose', [null]],
    ] as const) {
      expect(classifyCommand(name, args), name).toBeUndefined()
    }
  })

  it('reads the contexts a command hands to the test', () => {
    expect(readIntroducedContexts('url', { contextId: 'tab-a' })).toEqual([
      'tab-a',
    ])
    expect(
      readIntroducedContexts('browsingContexts', [
        { contextId: 'tab-a' },
        { contextId: 'tab-b' },
      ]),
    ).toEqual(['tab-a', 'tab-b'])
    expect(
      readIntroducedContexts('browsingContextCreate', { context: 'tab-c' }),
    ).toEqual(['tab-c'])
    expect(readIntroducedContexts('getWindowHandle', 'tab-a')).toEqual([
      'tab-a',
    ])
    expect(
      readIntroducedContexts('getWindowHandles', ['tab-a', 'tab-b']),
    ).toEqual(['tab-a', 'tab-b'])
    expect(readIntroducedContexts('getTitle', 'Title')).toEqual([])
    expect(readIntroducedContexts('getWindowHandle', undefined)).toEqual([])
    expect(readIntroducedContexts('execute', undefined)).toEqual([])
  })
})
