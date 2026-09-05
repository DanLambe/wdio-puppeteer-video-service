import type { Services } from '@wdio/types'
import {
  createLauncherCompositionRoot,
  type LauncherCompositionOverrides,
  type LauncherCompositionRoot,
} from './service/composition.js'
import {
  assignLauncherWorkerContext,
  createLauncherRegistrationError,
} from './service/launcher-context.js'
import * as logging from './service/logging.js'
import {
  assignManifestRunContext,
  assignManifestWorkerContext,
  type ManifestRunContext,
} from './service/manifest-runtime.js'
import * as normalization from './service/normalization.js'
import { resolveServiceConfiguration } from './service/options.js'
import { buildSpecRetryKey } from './service/retry-state.js'
import type {
  LogLevel,
  ResolvedWdioPuppeteerVideoServiceOptions,
  WdioPuppeteerVideoServiceOptions,
} from './types.js'

interface LauncherConfig {
  logLevel?: string
}

export default class WdioPuppeteerVideoLauncher
  implements Services.ServiceInstance
{
  private readonly _options: ResolvedWdioPuppeteerVideoServiceOptions
  private readonly _composition: LauncherCompositionRoot
  private readonly _logLevel: LogLevel
  private readonly _specRetryAttempts = new Map<string, number>()
  private _manifestRunContext: ManifestRunContext | undefined
  private _prepared = false
  private _runId: string | undefined

  constructor(
    options: WdioPuppeteerVideoServiceOptions = {},
    _capabilities?: unknown,
    config?: LauncherConfig,
    compositionOverrides?: LauncherCompositionOverrides,
  ) {
    this._composition = createLauncherCompositionRoot(compositionOverrides)
    const resolvedConfiguration = resolveServiceConfiguration(options)
    this._options = resolvedConfiguration.options
    this._logLevel = resolvedConfiguration.hasExplicitLogLevel
      ? resolvedConfiguration.logLevel
      : logging.normalizeLogLevel(config?.logLevel)
  }

  async onPrepare(): Promise<void> {
    this._specRetryAttempts.clear()
    const runId = this._composition.uuid()
    this._runId = runId
    try {
      this._manifestRunContext = await this._runManifestTask(
        'initialize manifest journaling',
        () =>
          this._composition.createManifestRunContext(
            this._options.outputDir,
            runId,
          ),
      )
      this._prepared = true
    } catch (error) {
      this._runId = undefined
      throw error
    }
  }

  onWorkerStart(
    cid: string,
    capabilities: WebdriverIO.Capabilities,
    specs: string[],
    args?: object,
  ): void {
    const runId = this._runId
    if (!this._prepared || !args || !runId) {
      throw createLauncherRegistrationError('missing')
    }

    assignLauncherWorkerContext(
      args,
      this._manifestRunContext !== undefined,
      runId,
    )
    if (this._manifestRunContext) {
      assignManifestRunContext(args, this._manifestRunContext)
    }

    const specRetryKey = `${cid}\0${buildSpecRetryKey(specs, capabilities)}`
    const specFileRetryAttempt = this._specRetryAttempts.get(specRetryKey) ?? 0
    this._specRetryAttempts.set(specRetryKey, specFileRetryAttempt + 1)
    assignManifestWorkerContext(args, cid, { specFileRetryAttempt })
    this._log(
      'debug',
      `[WdioPuppeteerVideoService] Worker start retry context cid=${cid} specFileRetryAttempt=${specFileRetryAttempt} specs=${specs.length.toString()}`,
    )
  }

  onWorkerEnd(
    cid: string,
    exitCode: number,
    specs: string[],
    retries: number,
  ): void {
    this._log(
      'trace',
      `[WdioPuppeteerVideoService] Worker end cid=${cid} exitCode=${exitCode.toString()} retries=${retries.toString()} specs=${specs.length.toString()}`,
    )
  }

  async onComplete(exitCode = 0): Promise<void> {
    this._specRetryAttempts.clear()
    this._prepared = false
    const runId = this._runId
    const manifestRunContext = this._manifestRunContext
    try {
      if (!manifestRunContext) {
        return
      }
      const manifest = await this._runManifestTask(
        'aggregate manifest journals',
        () =>
          this._composition.aggregateManifestRun(manifestRunContext, exitCode),
      )
      if (!manifest) {
        return
      }
      await this._runManifestTask('generate the static video report', () =>
        this._composition.generateVideoReportForRun({
          outputDir: manifestRunContext.outputDir,
          runId: manifestRunContext.runId,
          manifest,
        }),
      )
    } finally {
      this._manifestRunContext = undefined
      this._runId = undefined
      if (runId) {
        await this._cleanupGlobalSlots(runId)
      }
    }
  }

  private async _cleanupGlobalSlots(runId: string): Promise<void> {
    try {
      await this._composition.cleanupGlobalSlotRunDirectory({
        ...(this._options.concurrency.lockDir === undefined
          ? {}
          : { lockDir: this._options.concurrency.lockDir }),
        outputDir: this._options.outputDir,
        runId,
      })
    } catch (error) {
      this._log(
        'warn',
        `[WdioPuppeteerVideoService] Failed to clean the completed run's global slot directory: ${normalization.describeError(error)}. Later runs remain isolated by run ID.`,
      )
    }
  }

  private async _runManifestTask<T>(
    operation: string,
    task: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await task()
    } catch (error) {
      this._log(
        'warn',
        `[WdioPuppeteerVideoService] Failed to ${operation}: ${normalization.describeError(error)}.`,
      )
      if (this._options.failurePolicy === 'error') {
        throw error
      }
      return undefined
    }
  }

  private _log(level: LogLevel, message: string, details?: unknown): void {
    this._composition.writeLog(this._logLevel, level, message, details)
  }
}
