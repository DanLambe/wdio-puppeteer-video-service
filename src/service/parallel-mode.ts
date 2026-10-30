/**
 * WebdriverIO 10's parallel mode runs a spec file's tests at the same time in
 * one browser session, each in its own window. Recording follows one tab per
 * worker, so it would film and attribute the wrong test; the service declines
 * to record instead.
 */
const PARALLEL_MODES = new Set(['contexts', 'userContexts'])

// Exported by webdriverio as PARALLEL_CONTEXT_STORE_KEY. It is read by value
// so the service entry point stays importable without its peers installed.
const PARALLEL_CONTEXT_STORE_KEY = '__parallelContextStore'

export const PARALLEL_MODE_UNSUPPORTED_REASON =
  'WebdriverIO parallelMode runs several tests at once in one browser session, which recording does not support; turn parallelMode off for recorded runs'

interface FrameworkOptions {
  readonly parallelMode?: unknown
}

interface ParallelModeConfig {
  readonly cucumberOpts?: FrameworkOptions
  readonly framework?: unknown
  readonly mochaOpts?: FrameworkOptions
}

interface ParallelModeBrowser {
  readonly capabilities?: unknown
  readonly isBidi?: boolean
  readonly requestedCapabilities?: unknown
}

const configuredMode = (config: unknown): string | undefined => {
  const options = (config ?? {}) as ParallelModeConfig
  const value =
    options.framework === 'cucumber'
      ? options.cucumberOpts?.parallelMode
      : options.framework === 'mocha'
        ? options.mochaOpts?.parallelMode
        : undefined
  return typeof value === 'string' && PARALLEL_MODES.has(value)
    ? value
    : undefined
}

const enablesBidiCommands = (capabilities: unknown): boolean => {
  return (
    !!capabilities &&
    typeof capabilities === 'object' &&
    Reflect.get(capabilities, 'wdio:experimentalBiDiCommands') === true
  )
}

/**
 * Whether the framework will run tests in parallel. Without a BiDi session and
 * `wdio:experimentalBiDiCommands`, WDIO falls back to sequential execution.
 */
export const usesParallelMode = (
  config: unknown,
  browser: ParallelModeBrowser,
): boolean => {
  return (
    configuredMode(config) !== undefined &&
    browser.isBidi === true &&
    (enablesBidiCommands(browser.requestedCapabilities) ||
      enablesBidiCommands(browser.capabilities))
  )
}

/** Whether the calling test runs inside a parallel-mode browsing context. */
export const isInParallelContext = (browser: unknown): boolean => {
  if (!browser || typeof browser !== 'object') {
    return false
  }
  const store = Reflect.get(browser, PARALLEL_CONTEXT_STORE_KEY) as
    | { getStore?: () => unknown }
    | undefined
  return typeof store?.getStore?.() === 'string'
}
