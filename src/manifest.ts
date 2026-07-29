export const MANIFEST_SCHEMA_VERSION = 1 as const

export type ManifestProtocol = 'bidi+cdp' | 'classic+cdp' | 'unsupported'
export type ManifestFramework = 'mocha' | 'jasmine' | 'cucumber' | 'unknown'
export type ManifestRecordingScope = 'test' | 'spec'
export type ManifestResult = 'passed' | 'failed' | 'skipped' | 'unknown'
export type ManifestCaptureDecision =
  | 'recorded'
  | 'discarded'
  | 'skipped'
  | 'failed'
export type ManifestProcessingOutcome =
  | 'not-required'
  | 'pending'
  | 'completed'
  | 'failed'
  | 'skipped'

export interface ManifestToolVersions {
  service: string
  node: string
  webdriverio: string
  puppeteer: string
  ffmpeg?: string
}

export interface ManifestBrowser {
  name: string
  version?: string
  protocol: ManifestProtocol
}

export interface ManifestTestIdentity {
  name: string
  fullName?: string
}

export interface ManifestMediaArtifact {
  path: string
  mimeType: 'video/webm' | 'video/mp4'
  size: number
  width?: number
  height?: number
}

export interface ManifestTimings {
  startedAt: string
  captureStartedAt?: string
  captureStoppedAt?: string
  processingStartedAt?: string
  completedAt: string
  durationMs: number
}

export interface ManifestProcessing {
  timing: 'after-test' | 'after-worker'
  outcome: ManifestProcessingOutcome
  operation?: 'capture' | 'merge' | 'transcode'
  reason?: string
}

export interface ManifestCapture {
  decision: ManifestCaptureDecision
  reason?: string
  segments: ManifestMediaArtifact[]
  final?: ManifestMediaArtifact
}

export interface ManifestEntryV1 {
  id: string
  runId: string
  cid: string
  sessionHash: string
  browser: ManifestBrowser
  framework: ManifestFramework
  spec: string
  test?: ManifestTestIdentity
  scope: ManifestRecordingScope
  attempt: number
  result: ManifestResult
  capture: ManifestCapture
  processing: ManifestProcessing
  timings: ManifestTimings
}

export interface ManifestDiagnostic {
  code: 'malformed-final-journal-line' | 'invalid-journal-entry'
  journal: string
  line: number
}

export interface ManifestRunV1 {
  id: string
  startedAt: string
  completedAt: string
  exitCode: number
  tools: ManifestToolVersions
  entries: ManifestEntryV1[]
  diagnostics?: ManifestDiagnostic[]
}

export interface VideoManifestV1 {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION
  generatedAt: string
  runs: ManifestRunV1[]
}

export interface ManifestValidationResult {
  valid: boolean
  errors: string[]
}

const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u

/**
 * Validates the stable fields and semantics of manifest v1. Unknown fields are
 * intentionally accepted so additive optional fields remain minor-compatible.
 */
export const validateVideoManifest = (
  value: unknown,
): ManifestValidationResult => {
  const errors: string[] = []
  const root = readRecord(value, '$', errors)
  if (!root) {
    return { valid: false, errors }
  }

  expectLiteral(
    root.schemaVersion,
    MANIFEST_SCHEMA_VERSION,
    '$.schemaVersion',
    errors,
  )
  expectIsoDate(root.generatedAt, '$.generatedAt', errors)
  const runs = readArray(root.runs, '$.runs', errors)
  for (const [index, run] of (runs ?? []).entries()) {
    validateRun(run, `$.runs[${index.toString()}]`, errors)
  }

  return { valid: errors.length === 0, errors }
}

export const isVideoManifest = (value: unknown): value is VideoManifestV1 => {
  return validateVideoManifest(value).valid
}

const validateRun = (
  value: unknown,
  location: string,
  errors: string[],
): void => {
  const run = readRecord(value, location, errors)
  if (!run) {
    return
  }

  expectNonEmptyString(run.id, `${location}.id`, errors)
  expectIsoDate(run.startedAt, `${location}.startedAt`, errors)
  expectIsoDate(run.completedAt, `${location}.completedAt`, errors)
  expectInteger(run.exitCode, `${location}.exitCode`, errors, 0)
  validateTools(run.tools, `${location}.tools`, errors)
  const entries = readArray(run.entries, `${location}.entries`, errors)
  for (const [index, entry] of (entries ?? []).entries()) {
    validateEntry(entry, `${location}.entries[${index.toString()}]`, errors)
  }

  if (run.diagnostics !== undefined) {
    const diagnostics = readArray(
      run.diagnostics,
      `${location}.diagnostics`,
      errors,
    )
    for (const [index, diagnostic] of (diagnostics ?? []).entries()) {
      validateDiagnostic(
        diagnostic,
        `${location}.diagnostics[${index.toString()}]`,
        errors,
      )
    }
  }
}

const validateTools = (
  value: unknown,
  location: string,
  errors: string[],
): void => {
  const tools = readRecord(value, location, errors)
  if (!tools) {
    return
  }
  for (const key of ['service', 'node', 'webdriverio', 'puppeteer']) {
    expectNonEmptyString(tools[key], `${location}.${key}`, errors)
  }
  if (tools.ffmpeg !== undefined) {
    expectNonEmptyString(tools.ffmpeg, `${location}.ffmpeg`, errors)
  }
}

const validateEntry = (
  value: unknown,
  location: string,
  errors: string[],
): void => {
  const entry = readRecord(value, location, errors)
  if (!entry) {
    return
  }

  for (const key of ['id', 'runId', 'cid', 'sessionHash', 'spec']) {
    expectNonEmptyString(entry[key], `${location}.${key}`, errors)
  }
  validateBrowser(entry.browser, `${location}.browser`, errors)
  expectEnum(
    entry.framework,
    ['mocha', 'jasmine', 'cucumber', 'unknown'],
    `${location}.framework`,
    errors,
  )
  expectEnum(entry.scope, ['test', 'spec'], `${location}.scope`, errors)
  expectInteger(entry.attempt, `${location}.attempt`, errors, 1)
  expectEnum(
    entry.result,
    ['passed', 'failed', 'skipped', 'unknown'],
    `${location}.result`,
    errors,
  )
  if (entry.test !== undefined) {
    validateTestIdentity(entry.test, `${location}.test`, errors)
  }
  validateCapture(entry.capture, `${location}.capture`, errors)
  validateProcessing(entry.processing, `${location}.processing`, errors)
  validateTimings(entry.timings, `${location}.timings`, errors)
}

const validateBrowser = (
  value: unknown,
  location: string,
  errors: string[],
): void => {
  const browser = readRecord(value, location, errors)
  if (!browser) {
    return
  }
  expectNonEmptyString(browser.name, `${location}.name`, errors)
  if (browser.version !== undefined) {
    expectNonEmptyString(browser.version, `${location}.version`, errors)
  }
  expectEnum(
    browser.protocol,
    ['bidi+cdp', 'classic+cdp', 'unsupported'],
    `${location}.protocol`,
    errors,
  )
}

const validateTestIdentity = (
  value: unknown,
  location: string,
  errors: string[],
): void => {
  const test = readRecord(value, location, errors)
  if (!test) {
    return
  }
  expectNonEmptyString(test.name, `${location}.name`, errors)
  if (test.fullName !== undefined) {
    expectNonEmptyString(test.fullName, `${location}.fullName`, errors)
  }
}

const validateCapture = (
  value: unknown,
  location: string,
  errors: string[],
): void => {
  const capture = readRecord(value, location, errors)
  if (!capture) {
    return
  }
  expectEnum(
    capture.decision,
    ['recorded', 'discarded', 'skipped', 'failed'],
    `${location}.decision`,
    errors,
  )
  if (capture.reason !== undefined) {
    expectNonEmptyString(capture.reason, `${location}.reason`, errors)
  }
  const segments = readArray(capture.segments, `${location}.segments`, errors)
  for (const [index, artifact] of (segments ?? []).entries()) {
    validateArtifact(
      artifact,
      `${location}.segments[${index.toString()}]`,
      errors,
    )
  }
  if (capture.final !== undefined) {
    validateArtifact(capture.final, `${location}.final`, errors)
  }
}

const validateArtifact = (
  value: unknown,
  location: string,
  errors: string[],
): void => {
  const artifact = readRecord(value, location, errors)
  if (!artifact) {
    return
  }
  expectSafeRelativePath(artifact.path, `${location}.path`, errors)
  expectEnum(
    artifact.mimeType,
    ['video/webm', 'video/mp4'],
    `${location}.mimeType`,
    errors,
  )
  expectInteger(artifact.size, `${location}.size`, errors, 0)
  if (artifact.width !== undefined) {
    expectInteger(artifact.width, `${location}.width`, errors, 1)
  }
  if (artifact.height !== undefined) {
    expectInteger(artifact.height, `${location}.height`, errors, 1)
  }
  if ((artifact.width === undefined) !== (artifact.height === undefined)) {
    errors.push(
      `${location}.width and ${location}.height must be provided together`,
    )
  }
}

const validateProcessing = (
  value: unknown,
  location: string,
  errors: string[],
): void => {
  const processing = readRecord(value, location, errors)
  if (!processing) {
    return
  }
  expectEnum(
    processing.timing,
    ['after-test', 'after-worker'],
    `${location}.timing`,
    errors,
  )
  expectEnum(
    processing.outcome,
    ['not-required', 'pending', 'completed', 'failed', 'skipped'],
    `${location}.outcome`,
    errors,
  )
  if (processing.operation !== undefined) {
    expectEnum(
      processing.operation,
      ['capture', 'merge', 'transcode'],
      `${location}.operation`,
      errors,
    )
  }
  if (processing.reason !== undefined) {
    expectNonEmptyString(processing.reason, `${location}.reason`, errors)
  }
}

const validateTimings = (
  value: unknown,
  location: string,
  errors: string[],
): void => {
  const timings = readRecord(value, location, errors)
  if (!timings) {
    return
  }
  for (const key of ['startedAt', 'completedAt']) {
    expectIsoDate(timings[key], `${location}.${key}`, errors)
  }
  for (const key of [
    'captureStartedAt',
    'captureStoppedAt',
    'processingStartedAt',
  ]) {
    if (timings[key] !== undefined) {
      expectIsoDate(timings[key], `${location}.${key}`, errors)
    }
  }
  expectInteger(timings.durationMs, `${location}.durationMs`, errors, 0)
}

const validateDiagnostic = (
  value: unknown,
  location: string,
  errors: string[],
): void => {
  const diagnostic = readRecord(value, location, errors)
  if (!diagnostic) {
    return
  }
  expectEnum(
    diagnostic.code,
    ['malformed-final-journal-line', 'invalid-journal-entry'],
    `${location}.code`,
    errors,
  )
  expectSafeRelativePath(diagnostic.journal, `${location}.journal`, errors)
  expectInteger(diagnostic.line, `${location}.line`, errors, 1)
}

const readRecord = (
  value: unknown,
  location: string,
  errors: string[],
): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${location} must be an object`)
    return undefined
  }
  return value as Record<string, unknown>
}

const readArray = (
  value: unknown,
  location: string,
  errors: string[],
): unknown[] | undefined => {
  if (!Array.isArray(value)) {
    errors.push(`${location} must be an array`)
    return undefined
  }
  return value
}

const expectNonEmptyString = (
  value: unknown,
  location: string,
  errors: string[],
): void => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${location} must be a non-empty string`)
  }
}

const expectIsoDate = (
  value: unknown,
  location: string,
  errors: string[],
): void => {
  if (typeof value !== 'string' || !isIsoTimestamp(value)) {
    errors.push(`${location} must be an ISO-8601 timestamp`)
  }
}

const isIsoTimestamp = (value: string): boolean => {
  const match = ISO_TIMESTAMP_PATTERN.exec(value)
  if (!match || !Number.isFinite(Date.parse(value))) {
    return false
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = match[7] === undefined ? 0 : Number(match[7])
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8])
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1]
  return (
    daysInMonth !== undefined &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  )
}

const expectLiteral = (
  value: unknown,
  expected: string | number,
  location: string,
  errors: string[],
): void => {
  if (value !== expected) {
    errors.push(`${location} must equal ${JSON.stringify(expected)}`)
  }
}

const expectEnum = (
  value: unknown,
  allowed: readonly string[],
  location: string,
  errors: string[],
): void => {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    errors.push(`${location} must be one of: ${allowed.join(', ')}`)
  }
}

const expectInteger = (
  value: unknown,
  location: string,
  errors: string[],
  minimum: number,
): void => {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    errors.push(`${location} must be an integer >= ${minimum.toString()}`)
  }
}

const expectSafeRelativePath = (
  value: unknown,
  location: string,
  errors: string[],
): void => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.startsWith('/') ||
    /^[a-z]:/iu.test(value) ||
    value.split('/').includes('..') ||
    value.includes('\\')
  ) {
    errors.push(`${location} must be a normalized relative path`)
  }
}
