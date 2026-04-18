import path from 'node:path'
import {
  DEFAULT_OUTPUT_DIR,
  GLOBAL_RECORDING_SLOT_DIR_NAME,
  SPEC_RETRY_STATE_DIR_NAME,
} from './constants.js'

/**
 * Helpers for on-disk retry-state and cross-process recording-slot metadata.
 * These utilities are intentionally stateless and side-effect free.
 */

export const getSpecRetryStateDirPath = (
  outputDir: string | undefined,
): string => {
  return path.join(outputDir || DEFAULT_OUTPUT_DIR, SPEC_RETRY_STATE_DIR_NAME)
}

export const getSpecRetryStatePathForCid = (
  outputDir: string | undefined,
  cid: string,
): string => {
  const safeCidToken =
    cid.trim().replaceAll(/[^a-zA-Z0-9._-]/g, '_') || 'unknown'
  return path.join(getSpecRetryStateDirPath(outputDir), `${safeCidToken}.json`)
}

export const buildSpecRetryKey = (
  specs: string[],
  capabilities: WebdriverIO.Capabilities,
): string => {
  const normalizedSpecs = specs
    .map((specPath) => normalizeSpecPathForRetryKey(specPath))
    .sort((a, b) => a.localeCompare(b))
    .join('|')
  const capabilityFingerprint = buildStaticCapabilityFingerprint(capabilities)

  return `${capabilityFingerprint}|${normalizedSpecs}`
}

export const resolveGlobalRecordingLockDir = (
  outputDir: string | undefined,
  configuredDir: string | undefined,
): string => {
  const trimmedConfiguredDir = configuredDir?.trim()
  if (trimmedConfiguredDir) {
    return trimmedConfiguredDir
  }

  return path.join(
    outputDir || DEFAULT_OUTPUT_DIR,
    GLOBAL_RECORDING_SLOT_DIR_NAME,
  )
}

export const extractPidFromSlotFile = (
  fileContents: string,
): number | undefined => {
  return parseGlobalRecordingSlotMetadata(fileContents)?.pid
}

export interface GlobalRecordingSlotMetadata {
  pid?: number
  startedAt?: number
  lastUpdatedAt?: number
}

export const parseGlobalRecordingSlotMetadata = (
  fileContents: string,
): GlobalRecordingSlotMetadata | undefined => {
  if (!fileContents.trim()) {
    return undefined
  }

  try {
    const parsed = JSON.parse(fileContents) as Record<string, unknown>
    const pid = toPositiveInteger(parsed.pid)
    const startedAt = toPositiveInteger(parsed.startedAt)
    const lastUpdatedAt = toPositiveInteger(parsed.lastUpdatedAt)

    return {
      ...(pid === undefined ? {} : { pid }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(lastUpdatedAt === undefined ? {} : { lastUpdatedAt }),
    }
  } catch {
    // malformed slot metadata; ignore cleanup to avoid deleting active slots
    return undefined
  }
}

export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const processError = error as NodeJS.ErrnoException
    if (processError.code === 'ESRCH') {
      return false
    }
    return true
  }
}

const toNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }

  return trimmed
}

const STATIC_CAPABILITY_KEYS = [
  'browserName',
  'browserVersion',
  'platformName',
  'platformVersion',
  'platform',
  'deviceName',
  'appium:browserName',
  'appium:deviceName',
  'appium:platformName',
  'appium:platformVersion',
  'appium:automationName',
] as const

const APPIUM_OPTIONS_STATIC_KEYS = [
  'browserName',
  'deviceName',
  'platformName',
  'platformVersion',
  'automationName',
] as const

const normalizeSpecPathForRetryKey = (specPath: string): string => {
  const resolvedPath = path.resolve(specPath)
  if (path.sep === '\\') {
    return resolvedPath.toLowerCase()
  }
  return resolvedPath
}

const buildStaticCapabilityFingerprint = (
  capabilities: WebdriverIO.Capabilities,
): string => {
  const capabilityRecord = toRecord(capabilities)
  if (!capabilityRecord) {
    return 'capabilities'
  }

  const tokenMap = new Map<string, string>()
  const capabilitySources = getCapabilitySources(capabilityRecord)
  for (const capabilitySource of capabilitySources) {
    addStaticCapabilityTokens(capabilitySource, tokenMap)
  }

  if (tokenMap.size === 0) {
    return 'capabilities'
  }

  return [...tokenMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key}:${value}`)
    .join('|')
}

const addStaticCapabilityTokens = (
  capabilities: Record<string, unknown>,
  tokenMap: Map<string, string>,
): void => {
  for (const capabilityKey of STATIC_CAPABILITY_KEYS) {
    const normalizedValue = normalizeCapabilityValue(
      capabilities[capabilityKey],
    )
    if (!normalizedValue) {
      continue
    }
    if (!tokenMap.has(capabilityKey)) {
      tokenMap.set(capabilityKey, normalizedValue)
    }
  }

  const appiumOptions = toRecord(capabilities['appium:options'])
  if (!appiumOptions) {
    return
  }

  for (const appiumOptionKey of APPIUM_OPTIONS_STATIC_KEYS) {
    const normalizedValue = normalizeCapabilityValue(
      appiumOptions[appiumOptionKey],
    )
    if (!normalizedValue) {
      continue
    }
    const tokenKey = `appium:options.${appiumOptionKey}`
    if (!tokenMap.has(tokenKey)) {
      tokenMap.set(tokenKey, normalizedValue)
    }
  }
}

const getCapabilitySources = (
  capabilities: Record<string, unknown>,
): Array<Record<string, unknown>> => {
  const sourceList: Array<Record<string, unknown>> = [capabilities]
  const alwaysMatch = toRecord(capabilities.alwaysMatch)
  if (alwaysMatch) {
    sourceList.push(alwaysMatch)
  }

  const firstMatch = capabilities.firstMatch
  if (Array.isArray(firstMatch)) {
    for (const firstMatchCandidate of firstMatch) {
      const firstMatchRecord = toRecord(firstMatchCandidate)
      if (firstMatchRecord) {
        sourceList.push(firstMatchRecord)
      }
    }
  }

  const nestedCapabilities = toRecord(capabilities.capabilities)
  if (!nestedCapabilities) {
    return sourceList
  }

  sourceList.push(nestedCapabilities)
  const nestedAlwaysMatch = toRecord(nestedCapabilities.alwaysMatch)
  if (nestedAlwaysMatch) {
    sourceList.push(nestedAlwaysMatch)
  }

  const nestedFirstMatch = nestedCapabilities.firstMatch
  if (!Array.isArray(nestedFirstMatch)) {
    return sourceList
  }

  for (const nestedFirstMatchCandidate of nestedFirstMatch) {
    const nestedFirstMatchRecord = toRecord(nestedFirstMatchCandidate)
    if (nestedFirstMatchRecord) {
      sourceList.push(nestedFirstMatchRecord)
    }
  }

  return sourceList
}

const normalizeCapabilityValue = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const normalizedValue = toNonEmptyString(value)
    if (!normalizedValue) {
      return undefined
    }
    return normalizedValue.toLowerCase()
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return undefined
    }
    return String(value)
  }

  if (typeof value === 'boolean') {
    return String(value)
  }

  if (typeof value === 'bigint') {
    return String(value)
  }

  return undefined
}

const toRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  return value as Record<string, unknown>
}

const toPositiveInteger = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return undefined
  }

  return value
}
