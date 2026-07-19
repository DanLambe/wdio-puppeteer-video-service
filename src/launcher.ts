import type { Services } from '@wdio/types'
import { generateVideoReportForRun } from './reporter/report-generator.js'
import {
  assignLauncherWorkerContext,
  createLauncherRegistrationError,
} from './service/launcher-context.js'
import * as logging from './service/logging.js'
import {
  aggregateManifestRun,
  assignManifestRunContext,
  assignManifestWorkerContext,
  createManifestRunContext,
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
  private readonly _logLevel: LogLevel
  private readonly _specRetryAttempts = new Map<string, number>()
  private _manifestRunContext: ManifestRunContext | undefined
  private _prepared = false

  constructor(
    options: WdioPuppeteerVideoServiceOptions = {},
    _capabilities?: unknown,
    config?: LauncherConfig,
  ) {
    const resolvedConfiguration = resolveServiceConfiguration(options)
    this._options = resolvedConfiguration.options
    this._logLevel = resolvedConfiguration.hasExplicitLogLevel
      ? resolvedConfiguration.logLevel
      : logging.normalizeLogLevel(config?.logLevel)
  }

  async onPrepare(): Promise<void> {
    this._specRetryAttempts.clear()
    this._manifestRunContext = await this._runManifestTask(
      'initialize manifest journaling',
      () => createManifestRunContext(this._options.outputDir),
    )
    this._prepared = true
  }

  onWorkerStart(
    cid: string,
    capabilities: WebdriverIO.Capabilities,
    specs: string[],
    args?: object,
  ): void {
    if (!this._prepared || !args) {
      throw createLauncherRegistrationError('missing')
    }

    assignLauncherWorkerContext(args, this._manifestRunContext !== undefined)
    if (this._manifestRunContext) {
      assignManifestRunContext(args, this._manifestRunContext)
    }

    const specRetryKey = `${cid}\0${buildSpecRetryKey(specs, capabilities)}`
    const specFileRetryAttempt = this._options.recordOnRetries
      ? (this._specRetryAttempts.get(specRetryKey) ?? 0)
      : 0
    if (this._options.recordOnRetries) {
      this._specRetryAttempts.set(specRetryKey, specFileRetryAttempt + 1)
    }
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
    if (!this._manifestRunContext) {
      return
    }

    const manifestRunContext = this._manifestRunContext
    try {
      const manifest = await this._runManifestTask(
        'aggregate manifest journals',
        () => aggregateManifestRun(manifestRunContext, exitCode),
      )
      if (!manifest) {
        return
      }
      await this._runManifestTask('generate the static video report', () =>
        generateVideoReportForRun({
          outputDir: manifestRunContext.outputDir,
          runId: manifestRunContext.runId,
          manifest,
        }),
      )
    } finally {
      this._manifestRunContext = undefined
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
    logging.writeLog(this._logLevel, level, message, details)
  }
}
