import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_REPORT_FILE_NAME,
  REPORTER_FRAGMENT_SCHEMA_VERSION,
  type ReporterFragmentV1,
} from './types.js'

const REPORTER_WORK_DIR = '.wdio-video-report'
const REPORTER_FRAGMENT_DIR = 'fragments'

export const normalizeReportFileName = (value: unknown): string => {
  if (value === undefined) {
    return DEFAULT_REPORT_FILE_NAME
  }
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    path.basename(value) !== value ||
    path.extname(value).toLowerCase() !== '.html' ||
    containsInvalidFileNameCharacter(value)
  ) {
    throw new TypeError(
      'reportFileName must be a non-empty .html filename without directory segments',
    )
  }
  return value
}

const containsInvalidFileNameCharacter = (value: string): boolean => {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 32 || '<>:"|?*'.includes(character)
  })
}

export const getReporterFragmentDirectory = (
  outputDir: string,
  runId: string,
): string => {
  return path.join(
    path.resolve(outputDir),
    REPORTER_WORK_DIR,
    sanitizeFileToken(runId),
    REPORTER_FRAGMENT_DIR,
  )
}

export const writeReporterFragment = async (
  outputDir: string,
  fragment: ReporterFragmentV1,
): Promise<string> => {
  const fragmentDir = getReporterFragmentDirectory(outputDir, fragment.runId)
  await fs.mkdir(fragmentDir, { recursive: true })
  const fileName = `${sanitizeFileToken(fragment.cid)}-${process.pid.toString()}-${randomUUID()}.json`
  const fragmentPath = path.join(fragmentDir, fileName)
  const temporaryPath = `${fragmentPath}.${randomUUID()}.tmp`
  await fs.writeFile(temporaryPath, `${JSON.stringify(fragment)}\n`, 'utf8')
  await fs.rename(temporaryPath, fragmentPath)
  return fragmentPath
}

export const readReporterFragments = async (
  outputDir: string,
  runId: string,
): Promise<{
  fragments: ReporterFragmentV1[]
  invalidFiles: string[]
}> => {
  const fragmentDir = getReporterFragmentDirectory(outputDir, runId)
  const fileNames = await fs.readdir(fragmentDir).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  })
  const fragments: ReporterFragmentV1[] = []
  const invalidFiles: string[] = []
  for (const fileName of fileNames.sort()) {
    if (!fileName.endsWith('.json')) {
      continue
    }
    try {
      const parsed = JSON.parse(
        await fs.readFile(path.join(fragmentDir, fileName), 'utf8'),
      ) as unknown
      if (!isReporterFragment(parsed, runId)) {
        invalidFiles.push(fileName)
        continue
      }
      fragments.push(parsed)
    } catch {
      invalidFiles.push(fileName)
    }
  }
  return { fragments, invalidFiles }
}

const isReporterFragment = (
  value: unknown,
  expectedRunId: string,
): value is ReporterFragmentV1 => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const fragment = value as Partial<ReporterFragmentV1>
  const reportFileNameIsValid = (() => {
    try {
      return (
        normalizeReportFileName(fragment.reportFileName) ===
        fragment.reportFileName
      )
    } catch {
      return false
    }
  })()
  return (
    fragment.schemaVersion === REPORTER_FRAGMENT_SCHEMA_VERSION &&
    fragment.runId === expectedRunId &&
    typeof fragment.cid === 'string' &&
    Array.isArray(fragment.specs) &&
    fragment.specs.every((spec) => typeof spec === 'string') &&
    !!fragment.browser &&
    typeof fragment.browser.name === 'string' &&
    (fragment.browser.version === undefined ||
      typeof fragment.browser.version === 'string') &&
    reportFileNameIsValid &&
    typeof fragment.startedAt === 'string' &&
    typeof fragment.completedAt === 'string' &&
    Array.isArray(fragment.outcomes) &&
    fragment.outcomes.every((outcome) =>
      isReporterOutcome(outcome, expectedRunId, fragment.cid),
    )
  )
}

const isReporterOutcome = (
  value: unknown,
  expectedRunId: string,
  expectedCid: string | undefined,
): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const outcome = value as Record<string, unknown>
  const test = outcome.test as Record<string, unknown> | undefined
  const browser = outcome.browser as Record<string, unknown> | undefined
  const errors = outcome.errors as unknown[] | undefined
  return (
    typeof outcome.uid === 'string' &&
    outcome.runId === expectedRunId &&
    outcome.cid === expectedCid &&
    typeof outcome.spec === 'string' &&
    !!test &&
    typeof test.name === 'string' &&
    (test.fullName === undefined || typeof test.fullName === 'string') &&
    (test.parent === undefined || typeof test.parent === 'string') &&
    (test.containerName === undefined ||
      typeof test.containerName === 'string') &&
    !!browser &&
    typeof browser.name === 'string' &&
    (browser.version === undefined || typeof browser.version === 'string') &&
    Number.isInteger(outcome.attempt) &&
    (outcome.attempt as number) >= 1 &&
    typeof outcome.retried === 'boolean' &&
    isReporterStatus(outcome.status) &&
    Number.isInteger(outcome.durationMs) &&
    (outcome.durationMs as number) >= 0 &&
    (outcome.pendingReason === undefined ||
      typeof outcome.pendingReason === 'string') &&
    (errors === undefined ||
      (Array.isArray(errors) && errors.every(isReporterError)))
  )
}

const isReporterError = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const error = value as Record<string, unknown>
  return (
    typeof error.message === 'string' &&
    (error.stack === undefined || typeof error.stack === 'string')
  )
}

const isReporterStatus = (value: unknown): boolean => {
  return (
    value === 'passed' ||
    value === 'failed' ||
    value === 'skipped' ||
    value === 'pending' ||
    value === 'unknown'
  )
}

const sanitizeFileToken = (value: string): string => {
  const token = value.replace(/[^a-z0-9._-]+/giu, '_').replace(/^_+|_+$/gu, '')
  return token || 'unknown'
}
