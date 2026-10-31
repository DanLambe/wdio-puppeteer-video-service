import { classifyCommand, readIntroducedContexts } from './context-signals.js'
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
  readonly wasIntroduced: boolean
}

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
 * Only contexts the test can address are followed: those a command result has
 * handed to it, those it names in `switchToWindow`, and WDIO's current window,
 * which browser-level commands use implicitly. WDIO and other services also
 * run commands in the background, for example to install WDIO's scripts in an
 * iframe a page has just created; those must not move the recording.
 */
export class ContextFollower {
  private currentWindow: string | undefined
  private readonly getBrowser: () => ContextFollowerBrowser | undefined
  private readonly introduced = new Set<string>()
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
    this.introduced.clear()
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
    if (signal.kind === 'current') {
      const current = await this.readCurrentWindow()
      if (current) {
        await this.follow(current, 'command')
      }
      return
    }
    if (signal.kind === 'switch') {
      // The browser rejects a window it does not know, and the recording stays
      // where it is. A known window is followed before the switch, so capture
      // is ready for the next action; a rejection is undone afterwards.
      if (!(await this.isOpenWindow(signal.contextId))) {
        return
      }
      this.pendingSwitch = {
        contextId: signal.contextId,
        wasIntroduced: this.introduced.has(signal.contextId),
      }
      this.introduced.add(signal.contextId)
      this.currentWindow = signal.contextId
      await this.follow(signal.contextId, 'switch-to-window')
      return
    }
    if (!this.isAddressable(signal.contextId)) {
      return
    }
    const topLevel = await this.resolveTopLevel(signal.contextId)
    if (!topLevel) {
      return
    }
    if (signal.kind === 'close') {
      // Only a top-level context can be closed; the browser rejects a frame,
      // which leaves its tab and the recording untouched.
      if (
        topLevel === signal.contextId &&
        topLevel === this.target.recordedContextId
      ) {
        await this.target.stopClosingContext(topLevel)
      }
      return
    }
    await this.follow(topLevel, 'command')
  }

  async afterCommand(
    commandName: string,
    args: readonly unknown[],
    result: unknown,
    error: unknown,
  ): Promise<void> {
    if (error === undefined) {
      for (const contextId of readIntroducedContexts(commandName, result)) {
        this.introduced.add(contextId)
      }
    }
    if (commandName === 'switchToWindow') {
      await this.afterSwitch(error)
    } else if (commandName === 'browsingContextClose') {
      await this.afterContextClose(args, error)
    } else if (commandName === 'closeWindow') {
      await this.afterCloseWindow(error)
    }
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
   * had closed. Recording returns to WDIO's current window.
   */
  private async recoverFailedSwitch(pending: PendingSwitch): Promise<void> {
    this.topLevelByContext.delete(pending.contextId)
    if (!pending.wasIntroduced) {
      this.introduced.delete(pending.contextId)
    }
    if (this.currentWindow === pending.contextId) {
      this.currentWindow = undefined
    }
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

  private isAddressable(contextId: string): boolean {
    return (
      this.introduced.has(contextId) ||
      contextId === this.currentWindow ||
      contextId === this.target.recordedContextId
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
      this.introduced.add(this.currentWindow)
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
