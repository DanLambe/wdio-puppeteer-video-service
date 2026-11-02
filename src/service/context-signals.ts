/**
 * Recognizes which browsing context a WebdriverIO 10 command acts on.
 *
 * In a WebDriver BiDi session a test can drive a held browsing context without
 * switching to it, and service hooks are not told which context a command
 * targets. The nested protocol commands are, through their arguments: BiDi
 * parameters name their context, element references embed the navigable that
 * owns them, `switchToWindow` names its handle, and Classic commands without
 * an element act on WDIO's current window. Each signal arrives in
 * `beforeCommand`, before the command reaches the browser.
 */
export type ContextSignal =
  | Readonly<{ kind: 'drive'; contextId: string }>
  | Readonly<{ kind: 'switch'; contextId: string }>
  | Readonly<{ kind: 'close'; contextId: string }>
  /** A Classic command on WDIO's current window, which it does not name. */
  | Readonly<{ kind: 'current' }>

// BiDi commands a test uses to act on a page. Screenshots, printing and
// prompt handling are left out: reporters, other services and WDIO's own
// dialog handler issue them for contexts the test is not driving.
const CONTEXT_PARAMETER_COMMANDS = new Set([
  'browsingContextActivate',
  'browsingContextLocateNodes',
  'browsingContextNavigate',
  'browsingContextReload',
  'browsingContextSetViewport',
  'browsingContextTraverseHistory',
  'inputPerformActions',
  'inputReleaseActions',
  'inputSetFiles',
])

const SCRIPT_TARGET_COMMANDS = new Set(['scriptCallFunction', 'scriptEvaluate'])

// Classic protocol commands that act on WDIO's current window without an
// element reference: `browser.keys()` and element-free action sequences send
// `performActions` even in a BiDi session. Only protocol-level names are
// listed, because WDIO's browser and browsing-context commands reuse names
// such as `back` and `closeWindow` for actions on a held context. Reads and
// screenshots are left out for the same reason as above.
const CURRENT_WINDOW_COMMANDS = new Set([
  'executeAsyncScript',
  'executeScript',
  'fullscreenWindow',
  'maximizeWindow',
  'minimizeWindow',
  'navigateTo',
  'performActions',
  'releaseActions',
  'setWindowRect',
])

const ELEMENT_COMMAND = /^(?:element[A-Z]|getElement[A-Z]|isElement[A-Z])/u
const EXCLUDED_ELEMENT_COMMANDS = new Set(['takeElementScreenshot'])

// A BiDi shared element reference: `f.<navigable>.d.<document>.e.<node>`.
const SHARED_ELEMENT_REFERENCE = /^f\.([^.]+)\.d\./u

const readString = (value: unknown): string | undefined => {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const readRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  return value && typeof value === 'object'
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}

const signalFor = (
  kind: 'close' | 'drive' | 'switch',
  contextId: string | undefined,
): ContextSignal | undefined => {
  return contextId ? { kind, contextId } : undefined
}

/** The context a driving command names in its parameters or element reference. */
const readDrivenContext = (
  commandName: string,
  args: readonly unknown[],
): string | undefined => {
  if (CONTEXT_PARAMETER_COMMANDS.has(commandName)) {
    return readString(readRecord(args[0]).context)
  }
  if (SCRIPT_TARGET_COMMANDS.has(commandName)) {
    return readString(readRecord(readRecord(args[0]).target).context)
  }
  if (
    ELEMENT_COMMAND.test(commandName) &&
    !EXCLUDED_ELEMENT_COMMANDS.has(commandName)
  ) {
    return readString(args[0])?.match(SHARED_ELEMENT_REFERENCE)?.[1]
  }
  return undefined
}

export const classifyCommand = (
  commandName: string,
  args: readonly unknown[],
): ContextSignal | undefined => {
  if (commandName === 'switchToWindow') {
    return signalFor('switch', readString(args[0]))
  }
  if (commandName === 'browsingContextClose') {
    return signalFor('close', readString(readRecord(args[0]).context))
  }
  if (CURRENT_WINDOW_COMMANDS.has(commandName)) {
    return { kind: 'current' }
  }
  return signalFor('drive', readDrivenContext(commandName, args))
}

const readContextId = (value: unknown): string | undefined => {
  const record = readRecord(value)
  return readString(record.contextId) ?? readString(record.context)
}

/**
 * Browsing contexts a command's result hands to the test: a context from
 * `url()`, `newWindow()`, `frame()` or `browsingContexts()`, a protocol
 * `browsingContextCreate` result, or window handles. A test can drive only a
 * context it has been given, so WDIO's own setup of contexts the test has not
 * seen, such as the scripts it installs in a page's new iframe, is not mistaken
 * for the test driving them.
 */
export const readIntroducedContexts = (
  commandName: string,
  result: unknown,
): readonly string[] => {
  if (commandName === 'getWindowHandle') {
    const handle = readString(result)
    return handle ? [handle] : []
  }
  const values = Array.isArray(result) ? result : [result]
  const contexts: string[] = []
  for (const value of values) {
    const contextId =
      commandName === 'getWindowHandles' ? readString(value) : undefined
    const introduced = contextId ?? readContextId(value)
    if (introduced) {
      contexts.push(introduced)
    }
  }
  return contexts
}
