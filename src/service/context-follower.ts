import {
  type ContextLevel,
  type ContextSignal,
  classifyCommand,
  introductionLevel,
  readIntroducedContexts,
} from './context-signals.js'
import { runInternal } from './internal-operation.js'
import type { ServiceLogger } from './logging.js'
import { describeError } from './normalization.js'

export type FollowReason = 'command' | 'switch-to-window' | 'switch-failed'

/** The recording operations a context change drives. */
export interface ContextFollowerTarget {
  /** The context recording follows, whether or not capture is running. */
  readonly recordedContextId: string | undefined
  /** Whether a capture is attached for the followed context. */
  readonly hasActiveCapture: boolean
  followContext(contextId: string, reason: FollowReason): Promise<void>
  stopClosingContext(contextId: string): Promise<void>
  /** A close that stopped capture failed; the tab is still open. */
  recoverFailedClose(contextId: string): Promise<void>
  resumeAfterClose(): Promise<void>
}

/** A switch the browser has not accepted yet. */
interface PendingSwitch {
  readonly contextId: string
  readonly previousLevel: ContextLevel | undefined
}

type DriveSignal = Extract<ContextSignal, { kind: 'drive' | 'script' }>

interface ContextTreeNode {
  readonly context: string
  readonly children?: readonly ContextTreeNode[] | null
}

export interface ContextFollowerBrowser {
  browsingContextGetTree(
    parameters: Record<string, never>,
  ): Promise<{ readonly contexts: readonly ContextTreeNode[] }>
  getWindowHandle(): Promise<string>
}

export interface ContextFollowerOptions {
  readonly getBrowser: () => ContextFollowerBrowser | undefined
  readonly log: ServiceLogger
  readonly target: ContextFollowerTarget
}

/**
 * Follows the top-level browsing context a WebDriver BiDi test is driving.
 * A command aimed at a different tab or window starts a new segment there
 * before the command runs, so the action itself is filmed. Frames count as the
 * tab that contains them.
 *
 * Only contexts the test knows are followed: those a command result has
 * handed to it, those it names in `switchToWindow`, and WDIO's current window,
 * which browser-level commands use implicitly. WDIO and other services also
 * run commands in the background, for example to install WDIO's scripts in an
 * iframe or window a page has just opened; those must not move the recording.
 *
 * Scripts need more than a window handle: `getWindowHandles()` lists a window
 * WDIO is still setting up, so a script there follows only a context the test
 * holds or has switched to (`addressable`), WDIO's current window, or the
 * recorded tab. Other commands on a listed window are the test's own, and
 * make its tab addressable once followed.
 */
export class ContextFollower {
  private currentWindow: string | undefined
  private decisions = 0
  private readonly getBrowser: () => ContextFollowerBrowser | undefined
  /** How the test came to know each context; only ever raised. */
  private readonly levels = new Map<string, ContextLevel>()
  private readonly log: ServiceLogger
  private pendingSwitch: PendingSwitch | undefined
  private readonly target: ContextFollowerTarget
  private readonly topLevelByContext = new Map<string, string>()

  constructor(options: ContextFollowerOptions) {
    this.getBrowser = options.getBrowser
    this.log = options.log
    this.target = options.target
  }

  reset(): void {
    this.currentWindow = undefined
    this.pendingSwitch = undefined
    this.levels.clear()
    this.topLevelByContext.clear()
  }

  async beforeCommand(
    commandName: string,
    args: readonly unknown[],
  ): Promise<void> {
    const signal = classifyCommand(commandName, args)
    if (!signal) {
      return
    }
    switch (signal.kind) {
      case 'current':
        await this.followCurrentWindow()
        return
      case 'switch':
        await this.beforeSwitch(commandName, signal.contextId)
        return
      case 'close':
        await this.beforeClose(signal.contextId)
        return
      default:
        await this.beforeDrive(commandName, signal)
    }
  }

  async afterCommand(
    commandName: string,
    args: readonly unknown[],
    result: unknown,
    error: unknown,
  ): Promise<void> {
    if (error === undefined) {
      this.learnContexts(commandName, result)
    }
    if (commandName === 'switchToWindow') {
      await this.afterSwitch(error)
    } else if (commandName === 'browsingContextClose') {
      await this.afterContextClose(args, error)
    } else if (commandName === 'closeWindow') {
      await this.afterCloseWindow(error)
    }
  }

  private learnContexts(commandName: string, result: unknown): void {
    const level = introductionLevel(commandName)
    for (const contextId of readIntroducedContexts(commandName, result)) {
      this.raiseLevel(contextId, level)
      if (commandName === 'getWindowHandle') {
        // The singular handle is WDIO's current window.
        this.currentWindow = contextId
      }
    }
  }

  private raiseLevel(contextId: string, level: ContextLevel): void {
    if (level === 'addressable' || !this.levels.has(contextId)) {
      this.levels.set(contextId, level)
    }
  }

  private async followCurrentWindow(): Promise<void> {
    const current = await this.readCurrentWindow()
    if (current) {
      await this.follow(current, 'command')
    }
  }

  private async beforeSwitch(
    commandName: string,
    contextId: string,
  ): Promise<void> {
    // The browser rejects a window it does not know, and the recording stays
    // where it is. A known window is followed before the switch, so capture
    // is ready for the next action; a rejection is undone afterwards.
    if (!(await this.isOpenWindow(contextId))) {
      this.traceDecision(commandName, contextId, 'ignored: not an open window')
      return
    }
    this.traceDecision(commandName, contextId, 'follow (switch-to-window)')
    this.pendingSwitch = {
      contextId,
      previousLevel: this.levels.get(contextId),
    }
    this.levels.set(contextId, 'addressable')
    this.currentWindow = contextId
    await this.follow(contextId, 'switch-to-window')
  }

  private async beforeClose(contextId: string): Promise<void> {
    if (!this.isKnown(contextId)) {
      return
    }
    const topLevel = await this.resolveTopLevel(contextId)
    // Only a top-level context can be closed; the browser rejects a frame,
    // which leaves its tab and the recording untouched.
    if (topLevel === contextId && topLevel === this.target.recordedContextId) {
      await this.target.stopClosingContext(topLevel)
    }
  }

  private async beforeDrive(
    commandName: string,
    signal: DriveSignal,
  ): Promise<void> {
    const { contextId } = signal
    const isScript = signal.kind === 'script'
    const eligible = isScript
      ? await this.isScriptTarget(contextId)
      : this.isKnown(contextId)
    if (!eligible) {
      const why = isScript
        ? 'ignored: script on a context the test has not addressed'
        : 'ignored: unknown context'
      this.traceDecision(commandName, contextId, why)
      return
    }
    const topLevel = await this.resolveTopLevel(contextId)
    if (!topLevel) {
      this.traceDecision(commandName, contextId, 'ignored: not in the tree')
      return
    }
    this.traceDecision(commandName, contextId, `follow ${topLevel} (command)`)
    if (!isScript) {
      // The test drove the tab itself, so its later scripts there are too.
      this.levels.set(topLevel, 'addressable')
    }
    await this.follow(topLevel, 'command')
  }

  private async afterSwitch(error: unknown): Promise<void> {
    const pending = this.pendingSwitch
    this.pendingSwitch = undefined
    if (error !== undefined && pending) {
      await this.recoverFailedSwitch(pending)
    }
  }

  private async afterContextClose(
    args: readonly unknown[],
    error: unknown,
  ): Promise<void> {
    const signal = classifyCommand('browsingContextClose', args)
    if (error !== undefined && signal?.kind === 'close') {
      await this.target.recoverFailedClose(signal.contextId)
      return
    }
    if (signal?.kind === 'close' && signal.contextId === this.currentWindow) {
      this.currentWindow = undefined
    }
    await this.target.resumeAfterClose()
  }

  private async afterCloseWindow(error: unknown): Promise<void> {
    // A Classic close of the current window leaves no current window until
    // WDIO switches to another, which the next switchToWindow reports.
    if (error === undefined) {
      this.currentWindow = undefined
    }
    await this.target.resumeAfterClose()
  }

  /**
   * The browser kept its current window, typically because the requested one
   * had closed. The window is known as it was before the switch, and
   * recording returns to WDIO's current window.
   */
  private async recoverFailedSwitch(pending: PendingSwitch): Promise<void> {
    this.topLevelByContext.delete(pending.contextId)
    if (pending.previousLevel) {
      this.levels.set(pending.contextId, pending.previousLevel)
    } else {
      this.levels.delete(pending.contextId)
    }
    if (this.currentWindow === pending.contextId) {
      this.currentWindow = undefined
    }
    this.traceDecision(
      'switchToWindow',
      pending.contextId,
      'rejected: level restored',
    )
    const current = await this.readCurrentWindow()
    if (current && current !== pending.contextId) {
      await this.follow(current, 'switch-failed')
    }
  }

  private async follow(contextId: string, reason: FollowReason): Promise<void> {
    // Equality alone would hide a stopped or failed capture of the same tab;
    // the controller decides whether that tab is recorded again.
    if (
      contextId === this.target.recordedContextId &&
      this.target.hasActiveCapture
    ) {
      return
    }
    await this.target.followContext(contextId, reason)
  }

  /** Whether a non-script command on the context is the test's own. */
  private isKnown(contextId: string): boolean {
    return (
      this.levels.has(contextId) ||
      contextId === this.currentWindow ||
      contextId === this.target.recordedContextId
    )
  }

  /**
   * Whether a script in the context is the test's own. Root `execute()` runs
   * in WDIO's current window, which may only have been listed so far, so an
   * empty current-window cache is filled before deciding.
   */
  private async isScriptTarget(contextId: string): Promise<boolean> {
    if (
      this.levels.get(contextId) === 'addressable' ||
      contextId === this.currentWindow ||
      contextId === this.target.recordedContextId
    ) {
      return true
    }
    if (this.currentWindow !== undefined) {
      return false
    }
    return contextId === (await this.readCurrentWindow())
  }

  /** One line per decision, for diagnosing which command moved recording. */
  private traceDecision(
    commandName: string,
    contextId: string,
    decision: string,
  ): void {
    this.decisions += 1
    const level = this.levels.get(contextId) ?? 'unknown'
    const recorded = this.target.recordedContextId ?? 'none'
    const current = this.currentWindow ?? 'unknown'
    this.log(
      'trace',
      `[WdioPuppeteerVideoService] Tab decision #${this.decisions}: ${commandName} on ${contextId} (${level}), recorded ${recorded}, current ${current}: ${decision}.`,
    )
  }

  private async readCurrentWindow(): Promise<string | undefined> {
    if (this.currentWindow) {
      return this.currentWindow
    }
    const browser = this.getBrowser()
    if (!browser) {
      return undefined
    }
    try {
      this.currentWindow = await runInternal(() => browser.getWindowHandle())
      this.levels.set(this.currentWindow, 'addressable')
    } catch (error) {
      this.log(
        'debug',
        `[WdioPuppeteerVideoService] Could not read WDIO's current window: ${describeError(error)}`,
      )
    }
    return this.currentWindow
  }

  /**
   * Whether a window handle names an open top-level context. When the tree
   * cannot be read, the browser's answer to the command decides instead.
   */
  private async isOpenWindow(contextId: string): Promise<boolean> {
    const known = this.topLevelByContext.get(contextId)
    if (known) {
      return known === contextId
    }
    if (!(await this.readTree())) {
      return true
    }
    return this.topLevelByContext.get(contextId) === contextId
  }

  private async resolveTopLevel(
    contextId: string,
  ): Promise<string | undefined> {
    const known = this.topLevelByContext.get(contextId)
    if (known) {
      return known
    }
    if (!(await this.readTree())) {
      return undefined
    }
    return this.topLevelByContext.get(contextId)
  }

  private async readTree(): Promise<boolean> {
    const browser = this.getBrowser()
    if (!browser) {
      return false
    }
    try {
      const { contexts } = await runInternal(() =>
        browser.browsingContextGetTree({}),
      )
      this.topLevelByContext.clear()
      for (const root of contexts) {
        this.indexTree(root, root.context)
      }
      return true
    } catch (error) {
      this.log(
        'debug',
        `[WdioPuppeteerVideoService] Could not read the browsing context tree: ${describeError(error)}`,
      )
      return false
    }
  }

  private indexTree(node: ContextTreeNode, topLevel: string): void {
    this.topLevelByContext.set(node.context, topLevel)
    for (const child of node.children ?? []) {
      this.indexTree(child, topLevel)
    }
  }
}
