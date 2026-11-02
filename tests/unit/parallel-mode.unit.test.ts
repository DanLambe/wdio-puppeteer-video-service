import { describe, expect, it } from 'vitest'
import {
  isInParallelContext,
  usesParallelMode,
} from '../../src/service/parallel-mode.js'

const bidiCommands = { 'wdio:experimentalBiDiCommands': true }

describe('WebdriverIO parallel mode detection', () => {
  it('detects Mocha and Cucumber parallel mode that WDIO will run', () => {
    const browser = { isBidi: true, capabilities: bidiCommands }

    expect(
      usesParallelMode(
        { framework: 'mocha', mochaOpts: { parallelMode: 'contexts' } },
        browser,
      ),
    ).toBe(true)
    expect(
      usesParallelMode(
        {
          framework: 'cucumber',
          cucumberOpts: { parallelMode: 'userContexts' },
        },
        { isBidi: true, requestedCapabilities: bidiCommands },
      ),
    ).toBe(true)
  })

  it('ignores parallel mode that WDIO falls back from or that is not set', () => {
    const mocha = {
      framework: 'mocha',
      mochaOpts: { parallelMode: 'contexts' },
    }

    // Without BiDi or the experimental BiDi commands, WDIO runs sequentially.
    expect(
      usesParallelMode(mocha, { isBidi: false, capabilities: bidiCommands }),
    ).toBe(false)
    expect(usesParallelMode(mocha, { isBidi: true, capabilities: {} })).toBe(
      false,
    )
    expect(usesParallelMode(mocha, { isBidi: true })).toBe(false)
    // Options of another framework, unknown modes and no config.
    expect(
      usesParallelMode(
        { framework: 'jasmine', mochaOpts: { parallelMode: 'contexts' } },
        { isBidi: true, capabilities: bidiCommands },
      ),
    ).toBe(false)
    expect(
      usesParallelMode(
        { framework: 'mocha', mochaOpts: { parallelMode: 'everything' } },
        { isBidi: true, capabilities: bidiCommands },
      ),
    ).toBe(false)
    expect(
      usesParallelMode(undefined, { isBidi: true, capabilities: bidiCommands }),
    ).toBe(false)
  })

  it('detects a test running inside a parallel-mode context', () => {
    const store = (value: unknown) => ({
      __parallelContextStore: { getStore: () => value },
    })

    expect(isInParallelContext(store('context-1'))).toBe(true)
    expect(isInParallelContext(store(undefined))).toBe(false)
    expect(isInParallelContext({})).toBe(false)
    expect(isInParallelContext(undefined)).toBe(false)
  })
})
