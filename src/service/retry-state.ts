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
    .map((specPath) => path.resolve(specPath))
    .sort((a, b) => a.localeCompare(b))
    .join('|')
  const capabilityFingerprint = toNonEmptyString(JSON.stringify(capabilities))

  return `${capabilityFingerprint || 'capabilities'}|${normalizedSpecs}`
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
  if (!fileContents.trim()) {
    return undefined
  }

  try {
    const parsed = JSON.parse(fileContents) as { pid?: unknown }
    if (
      typeof parsed.pid === 'number' &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0
    ) {
      return parsed.pid
    }
  } catch {
    // malformed slot metadata; ignore cleanup to avoid deleting active slots
  }

  return undefined
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
