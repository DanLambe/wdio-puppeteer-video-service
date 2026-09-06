import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { ManifestToolVersions } from '../manifest.js'
import { isSafeGlobalSlotRunId } from './global-slot-directory.js'
import { getManifestJournalDirectory } from './manifest-journal.js'

const require = createRequire(import.meta.url)

export const MANIFEST_RUN_CONFIG_KEY =
  'wdioPuppeteerVideoServiceManifestRun' as const
export const MANIFEST_WORKER_CONFIG_KEY =
  'wdioPuppeteerVideoServiceManifestWorker' as const

export interface ManifestRunContext {
  readonly runId: string
  readonly outputDir: string
  readonly startedAt: string
  readonly tools: ManifestToolVersions
}

export interface ManifestWorkerContext {
  readonly specFileRetryAttempt: number
}

interface ManifestWorkerContextEnvelope {
  readonly contexts: Record<string, ManifestWorkerContext>
  readonly version: 1
}

export const createManifestRunContext = async (
  outputDir: string,
  runId: string = randomUUID(),
): Promise<ManifestRunContext> => {
  if (!isSafeGlobalSlotRunId(runId)) {
    throw new TypeError(
      '[WdioPuppeteerVideoService] The launcher run ID is unsafe for manifest path construction.',
    )
  }
  const context: ManifestRunContext = {
    runId,
    outputDir: path.resolve(outputDir),
    startedAt: new Date().toISOString(),
    tools: {
      service: readPackageVersion('wdio-puppeteer-video-service'),
      node: process.version,
      webdriverio: readPackageVersion('webdriverio'),
      puppeteer: readPackageVersion('puppeteer-core'),
    },
  }
  await fs.mkdir(getManifestJournalDirectory(context), { recursive: true })
  return context
}

export const assignManifestRunContext = (
  config: object,
  context: ManifestRunContext,
): void => {
  Object.assign(config, { [MANIFEST_RUN_CONFIG_KEY]: context })
}

export const assignManifestWorkerContext = (
  config: object,
  cid: string,
  context: ManifestWorkerContext,
): void => {
  const existing = readManifestWorkerContextEnvelope(config)
  Object.assign(config, {
    [MANIFEST_WORKER_CONFIG_KEY]: {
      contexts: {
        ...existing?.contexts,
        [cid]: context,
      },
      version: 1,
    } satisfies ManifestWorkerContextEnvelope,
  })
}

export const readManifestRunContext = (
  config: unknown,
): ManifestRunContext | undefined => {
  if (!config || typeof config !== 'object') {
    return undefined
  }
  const value = (config as Record<string, unknown>)[MANIFEST_RUN_CONFIG_KEY]
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const context = value as Record<string, unknown>
  if (
    !isNonEmptyString(context.runId) ||
    !isNonEmptyString(context.outputDir) ||
    !path.isAbsolute(context.outputDir) ||
    !isNonEmptyString(context.startedAt) ||
    !Number.isFinite(Date.parse(context.startedAt)) ||
    !isManifestToolVersions(context.tools)
  ) {
    return undefined
  }
  return {
    runId: context.runId,
    outputDir: context.outputDir,
    startedAt: context.startedAt,
    tools: context.tools,
  }
}

export const readManifestWorkerContext = (
  config: unknown,
  cid: string,
): ManifestWorkerContext | undefined => {
  return readManifestWorkerContextEnvelope(config)?.contexts[cid]
}

export const hasManifestWorkerContexts = (config: unknown): boolean => {
  const envelope = readManifestWorkerContextEnvelope(config)
  return envelope !== undefined && Object.keys(envelope.contexts).length > 0
}

const readManifestWorkerContextEnvelope = (
  config: unknown,
): ManifestWorkerContextEnvelope | undefined => {
  if (!config || typeof config !== 'object') {
    return undefined
  }
  const value = (config as Record<string, unknown>)[MANIFEST_WORKER_CONFIG_KEY]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const envelope = value as Partial<ManifestWorkerContextEnvelope>
  if (
    envelope.version !== 1 ||
    !envelope.contexts ||
    typeof envelope.contexts !== 'object' ||
    Array.isArray(envelope.contexts)
  ) {
    return undefined
  }

  const contexts = envelope.contexts as Record<string, unknown>
  for (const [cid, contextValue] of Object.entries(contexts)) {
    if (!cid || !isManifestWorkerContext(contextValue)) {
      return undefined
    }
  }
  return envelope as ManifestWorkerContextEnvelope
}

const isManifestWorkerContext = (
  value: unknown,
): value is ManifestWorkerContext => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const attempt = (value as Partial<ManifestWorkerContext>).specFileRetryAttempt
  return Number.isInteger(attempt) && (attempt ?? -1) >= 0
}

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.trim().length > 0
}

const isManifestToolVersions = (
  value: unknown,
): value is ManifestToolVersions => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const tools = value as Record<string, unknown>
  return (
    isNonEmptyString(tools.service) &&
    isNonEmptyString(tools.node) &&
    isNonEmptyString(tools.webdriverio) &&
    isNonEmptyString(tools.puppeteer) &&
    (tools.ffmpeg === undefined || isNonEmptyString(tools.ffmpeg))
  )
}

const readPackageVersion = (packageName: string): string => {
  if (packageName === 'wdio-puppeteer-video-service') {
    const packagePath = path.resolve(import.meta.dirname, '../../package.json')
    return readPackageVersionFile(packagePath)
  }
  try {
    return readPackageVersionFile(
      require.resolve(`${packageName}/package.json`),
    )
  } catch {
    try {
      const entryDirectory = path.dirname(require.resolve(packageName))
      const directParentVersion = readPackageVersionFile(
        path.resolve(entryDirectory, '../package.json'),
      )
      if (directParentVersion !== 'unknown') {
        return directParentVersion
      }
      return readPackageVersionFile(
        path.resolve(entryDirectory, '../../package.json'),
      )
    } catch {
      return 'unknown'
    }
  }
}

const readPackageVersionFile = (packagePath: string): string => {
  try {
    const packageJson = require(packagePath) as { version?: unknown }
    return typeof packageJson.version === 'string'
      ? packageJson.version
      : 'unknown'
  } catch {
    return 'unknown'
  }
}
