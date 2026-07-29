export const LAUNCHER_WORKER_CONFIG_KEY =
  'wdioPuppeteerVideoServiceLauncherWorker' as const

const LAUNCHER_WORKER_CONTEXT_VERSION = 1 as const

export interface LauncherWorkerContext {
  initialized: true
  manifestContextAvailable: boolean
  version: typeof LAUNCHER_WORKER_CONTEXT_VERSION
}

export type LauncherWorkerContextResult =
  | { context: LauncherWorkerContext; status: 'valid' }
  | { status: 'malformed' | 'missing' }

export const assignLauncherWorkerContext = (
  config: object,
  manifestContextAvailable: boolean,
): void => {
  Object.assign(config, {
    [LAUNCHER_WORKER_CONFIG_KEY]: {
      initialized: true,
      manifestContextAvailable,
      version: LAUNCHER_WORKER_CONTEXT_VERSION,
    } satisfies LauncherWorkerContext,
  })
}

export const inspectLauncherWorkerContext = (
  config: unknown,
): LauncherWorkerContextResult => {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { status: 'missing' }
  }

  const value = (config as Record<string, unknown>)[LAUNCHER_WORKER_CONFIG_KEY]
  if (value === undefined) {
    return { status: 'missing' }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'malformed' }
  }

  const context = value as Partial<LauncherWorkerContext>
  if (
    context.initialized !== true ||
    typeof context.manifestContextAvailable !== 'boolean' ||
    context.version !== LAUNCHER_WORKER_CONTEXT_VERSION
  ) {
    return { status: 'malformed' }
  }

  return { context: context as LauncherWorkerContext, status: 'valid' }
}

export const createLauncherRegistrationError = (
  status: 'malformed' | 'missing',
): TypeError => {
  const problem =
    status === 'missing'
      ? 'The WDIO launcher context is missing.'
      : 'The WDIO launcher context is malformed or from an unsupported version.'
  return new TypeError(
    `[WdioPuppeteerVideoService] ${problem} Register the service by package name so WebdriverIO can load its named launcher export: services: [['puppeteer-video', options]]. Direct class registration such as services: [[WdioPuppeteerVideoService, options]] is not supported in 1.0.`,
  )
}
