import type { Frameworks, Services } from '@wdio/types'
import type { Browser } from 'webdriverio'
import type { WorkerCompositionOverrides } from './service/composition.js'
import * as logging from './service/logging.js'
import { describeUnsupportedWorker } from './service/protocol.js'
import { WdioPuppeteerVideoWorkerRuntime } from './service/worker-runtime.js'
import type { WdioPuppeteerVideoServiceOptions } from './types.js'

/** WebdriverIO worker service hook adapter. */
export default class WdioPuppeteerVideoService
  implements Services.ServiceInstance
{
  /**
   * Called by WDIO before it constructs the worker service. Capabilities this
   * service can never record skip it, so those workers write no manifest
   * entries.
   */
  static shouldRun(options: unknown, capabilities: unknown): boolean {
    const reason = describeUnsupportedWorker(capabilities)
    if (!reason) {
      return true
    }
    const logLevel =
      options && typeof options === 'object'
        ? Reflect.get(options, 'logLevel')
        : undefined
    logging.writeLog(
      logging.normalizeLogLevel(
        typeof logLevel === 'string' ? logLevel : undefined,
      ),
      'warn',
      `[WdioPuppeteerVideoService] Recording skipped for this worker: ${reason}.`,
    )
    return false
  }

  private readonly worker: WdioPuppeteerVideoWorkerRuntime

  constructor(
    options: WdioPuppeteerVideoServiceOptions = {},
    capabilities?: unknown,
    config?: unknown,
    compositionOverrides?: WorkerCompositionOverrides,
  ) {
    this.worker = new WdioPuppeteerVideoWorkerRuntime(
      options,
      capabilities,
      config,
      compositionOverrides,
    )
  }

  async beforeSession(
    config: unknown,
    capabilities: WebdriverIO.Capabilities,
    specs: string[],
    cid: string,
  ): Promise<void> {
    await this.worker.beforeSession(config, capabilities, specs, cid)
  }

  async before(
    capabilities: WebdriverIO.Capabilities,
    specs: string[],
    browser: Browser,
  ): Promise<void> {
    await this.worker.before(capabilities, specs, browser)
  }

  async beforeTest(test: Frameworks.Test, context: unknown): Promise<void> {
    await this.worker.beforeTest(test, context)
  }

  async afterTest(
    test: Frameworks.Test,
    context: unknown,
    result: Frameworks.TestResult,
  ): Promise<void> {
    await this.worker.afterTest(test, context, result)
  }

  async beforeScenario(
    world: Frameworks.World,
    context: unknown,
  ): Promise<void> {
    await this.worker.beforeScenario(world, context)
  }

  async afterScenario(
    world: Frameworks.World,
    result: Frameworks.PickleResult,
  ): Promise<void> {
    await this.worker.afterScenario(world, result)
  }

  async after(): Promise<void> {
    await this.worker.after()
  }

  async afterSession(): Promise<void> {
    await this.worker.afterSession()
  }

  async onReload(oldSessionId: string, newSessionId: string): Promise<void> {
    await this.worker.onReload(oldSessionId, newSessionId)
  }

  async beforeCommand(commandName: string, args?: unknown[]): Promise<void> {
    await this.worker.beforeCommand(commandName, args)
  }

  async afterCommand(
    commandName: string,
    args?: unknown[],
    result?: unknown,
    error?: Error,
  ): Promise<void> {
    await this.worker.afterCommand(commandName, args, result, error)
  }
}
