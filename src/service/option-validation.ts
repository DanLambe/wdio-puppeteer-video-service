import type { WdioPuppeteerVideoServiceOptions } from '../types.js'

const ROOT_OPTIONS = [
  'outputDir',
  'recording',
  'capture',
  'processing',
  'concurrency',
  'artifacts',
  'integrations',
  'profile',
  'logLevel',
  'failurePolicy',
] as const

const BETA_OPTION_MIGRATIONS: Readonly<Record<string, string>> = {
  saveAllVideos: "recording.retain: 'all'",
  videoWidth: 'capture.viewport.width',
  videoHeight: 'capture.viewport.height',
  fps: 'capture.fps',
  recordOnRetries:
    "recording.attempts: 'retries' and recording.retain: 'retries'",
  specLevelRecording: "recording.scope: 'spec'",
  skipViewPortKickoff: 'capture.framePriming: false',
  segmentOnWindowSwitch: "recording.windowChanges: 'segment' or 'ignore'",
  maxConcurrentRecordings: 'concurrency.maxRecordingsPerProcess',
  maxGlobalRecordings: 'concurrency.maxRecordingsGlobal',
  recordingStartMode: 'concurrency.startMode',
  recordingStartTimeoutMs: 'concurrency.startTimeoutMs',
  globalRecordingLockDir: 'concurrency.lockDir',
  postProcessMode: 'processing.timing',
  includeSpecPatterns: 'recording.filters.includeSpecs',
  excludeSpecPatterns: 'recording.filters.excludeSpecs',
  includeTagPatterns: 'recording.filters.includeTags',
  excludeTagPatterns: 'recording.filters.excludeTags',
  performanceProfile: 'profile',
  maxFileNameLength: 'artifacts.naming.maxLength',
  fileNameOverflowStrategy: 'artifacts.naming.overflow',
  fileNameStyle: 'artifacts.naming.style',
  ffmpegPath: 'processing.ffmpeg.path',
  ffmpegTimeoutMs: 'processing.ffmpeg.timeoutMs',
  outputFormat: 'processing.format',
  mp4Mode: 'processing.mp4Mode',
  transcode: 'processing.transcode',
  mergeSegments: 'processing.merge',
}

type OptionRecord = Record<string, unknown>

export function validateServiceOptions(
  options: unknown,
): asserts options is WdioPuppeteerVideoServiceOptions {
  const root = requireOptionObject(options, 'configuration')
  assertKnownRootOptions(root)

  assertOptionalNonEmptyString(root.outputDir, 'outputDir')
  assertOptionalEnum(root.profile, 'profile', ['default', 'parallel', 'ci'])
  assertOptionalEnum(root.logLevel, 'logLevel', [
    'trace',
    'debug',
    'info',
    'warn',
    'error',
    'silent',
  ])
  assertOptionalEnum(root.failurePolicy, 'failurePolicy', ['warn', 'error'])

  validateRecording(root.recording)
  validateCapture(root.capture)
  validateProcessing(root.processing)
  validateConcurrency(root.concurrency)
  validateArtifacts(root.artifacts)
  validateIntegrations(root.integrations)
  validateIntegrationCompatibility(root)
}

const validateRecording = (value: unknown): void => {
  const recording = readOptionalOptionObject(value, 'recording')
  if (!recording) {
    return
  }

  assertKnownOptions(recording, 'recording', [
    'scope',
    'attempts',
    'retain',
    'windowChanges',
    'filters',
  ])
  assertOptionalEnum(recording.scope, 'recording.scope', ['test', 'spec'])
  assertOptionalEnum(recording.attempts, 'recording.attempts', [
    'all',
    'retries',
  ])
  assertOptionalEnum(recording.retain, 'recording.retain', [
    'failures',
    'retries',
    'all',
  ])
  assertOptionalEnum(recording.windowChanges, 'recording.windowChanges', [
    'segment',
    'ignore',
  ])
  validateRecordingFilters(recording.filters)
}

const validateRecordingFilters = (value: unknown): void => {
  const filters = readOptionalOptionObject(value, 'recording.filters')
  if (!filters) {
    return
  }

  assertKnownOptions(filters, 'recording.filters', [
    'includeSpecs',
    'excludeSpecs',
    'includeTags',
    'excludeTags',
  ])
  assertOptionalStringArray(
    filters.includeSpecs,
    'recording.filters.includeSpecs',
  )
  assertOptionalStringArray(
    filters.excludeSpecs,
    'recording.filters.excludeSpecs',
  )
  assertOptionalStringArray(
    filters.includeTags,
    'recording.filters.includeTags',
  )
  assertOptionalStringArray(
    filters.excludeTags,
    'recording.filters.excludeTags',
  )
}

const validateCapture = (value: unknown): void => {
  const capture = readOptionalOptionObject(value, 'capture')
  if (!capture) {
    return
  }

  assertKnownOptions(capture, 'capture', [
    'viewport',
    'fps',
    'quality',
    'scale',
    'speed',
    'crop',
    'framePriming',
    'connectionTimeoutMs',
  ])
  validateCaptureViewport(capture.viewport)
  assertOptionalInteger(capture.fps, 'capture.fps', 1)
  assertOptionalInteger(capture.quality, 'capture.quality', 0, 63)
  assertOptionalPositiveNumber(capture.scale, 'capture.scale')
  assertOptionalPositiveNumber(capture.speed, 'capture.speed')
  validateCaptureCrop(capture.crop)
  assertOptionalBoolean(capture.framePriming, 'capture.framePriming')
  assertOptionalInteger(
    capture.connectionTimeoutMs,
    'capture.connectionTimeoutMs',
    1,
  )
}

const validateCaptureViewport = (value: unknown): void => {
  if (value === undefined || value === 'current') {
    return
  }
  const viewport = requireOptionObject(value, 'capture.viewport')
  assertKnownOptions(viewport, 'capture.viewport', ['width', 'height'])
  assertRequiredInteger(viewport.width, 'capture.viewport.width', 1)
  assertRequiredInteger(viewport.height, 'capture.viewport.height', 1)
}

const validateCaptureCrop = (value: unknown): void => {
  const crop = readOptionalOptionObject(value, 'capture.crop')
  if (!crop) {
    return
  }
  assertKnownOptions(crop, 'capture.crop', ['x', 'y', 'width', 'height'])
  assertRequiredInteger(crop.x, 'capture.crop.x', 0)
  assertRequiredInteger(crop.y, 'capture.crop.y', 0)
  assertRequiredInteger(crop.width, 'capture.crop.width', 1)
  assertRequiredInteger(crop.height, 'capture.crop.height', 1)
}

const validateProcessing = (value: unknown): void => {
  const processing = readOptionalOptionObject(value, 'processing')
  if (!processing) {
    return
  }

  assertKnownOptions(processing, 'processing', [
    'format',
    'mp4Mode',
    'timing',
    'ffmpeg',
    'transcode',
    'merge',
  ])
  assertOptionalEnum(processing.format, 'processing.format', ['webm', 'mp4'])
  assertOptionalEnum(processing.mp4Mode, 'processing.mp4Mode', [
    'auto',
    'direct',
    'transcode',
  ])
  assertOptionalEnum(processing.timing, 'processing.timing', [
    'after-test',
    'after-worker',
  ])
  validateFfmpeg(processing.ffmpeg)
  validateTranscode(processing.transcode)
  validateMerge(processing.merge)
}

const validateFfmpeg = (value: unknown): void => {
  const ffmpeg = readOptionalOptionObject(value, 'processing.ffmpeg')
  if (!ffmpeg) {
    return
  }

  assertKnownOptions(ffmpeg, 'processing.ffmpeg', ['path', 'timeoutMs'])
  assertOptionalNonEmptyString(ffmpeg.path, 'processing.ffmpeg.path')
  assertOptionalInteger(ffmpeg.timeoutMs, 'processing.ffmpeg.timeoutMs', 0)
}

const validateTranscode = (value: unknown): void => {
  const transcode = readOptionalOptionObject(value, 'processing.transcode')
  if (!transcode) {
    return
  }

  assertKnownOptions(transcode, 'processing.transcode', [
    'enabled',
    'deleteOriginal',
    'ffmpegArgs',
  ])
  assertOptionalBoolean(transcode.enabled, 'processing.transcode.enabled')
  assertOptionalBoolean(
    transcode.deleteOriginal,
    'processing.transcode.deleteOriginal',
  )
  assertOptionalStringArray(
    transcode.ffmpegArgs,
    'processing.transcode.ffmpegArgs',
  )
}

const validateMerge = (value: unknown): void => {
  const merge = readOptionalOptionObject(value, 'processing.merge')
  if (!merge) {
    return
  }

  assertKnownOptions(merge, 'processing.merge', ['enabled', 'deleteSegments'])
  assertOptionalBoolean(merge.enabled, 'processing.merge.enabled')
  assertOptionalBoolean(merge.deleteSegments, 'processing.merge.deleteSegments')
}

const validateConcurrency = (value: unknown): void => {
  const concurrency = readOptionalOptionObject(value, 'concurrency')
  if (!concurrency) {
    return
  }

  assertKnownOptions(concurrency, 'concurrency', [
    'maxRecordingsPerProcess',
    'maxRecordingsGlobal',
    'startMode',
    'startTimeoutMs',
    'maxPostProcessesPerProcess',
    'maxPostProcessesGlobal',
    'postProcessStartMode',
    'postProcessStartTimeoutMs',
    'lockDir',
  ])
  assertOptionalInteger(
    concurrency.maxRecordingsPerProcess,
    'concurrency.maxRecordingsPerProcess',
    0,
  )
  assertOptionalInteger(
    concurrency.maxRecordingsGlobal,
    'concurrency.maxRecordingsGlobal',
    0,
  )
  assertOptionalEnum(concurrency.startMode, 'concurrency.startMode', [
    'blocking',
    'fast-fail',
  ])
  assertOptionalInteger(
    concurrency.startTimeoutMs,
    'concurrency.startTimeoutMs',
    1,
  )
  assertOptionalInteger(
    concurrency.maxPostProcessesPerProcess,
    'concurrency.maxPostProcessesPerProcess',
    0,
  )
  assertOptionalInteger(
    concurrency.maxPostProcessesGlobal,
    'concurrency.maxPostProcessesGlobal',
    0,
  )
  assertOptionalEnum(
    concurrency.postProcessStartMode,
    'concurrency.postProcessStartMode',
    ['blocking', 'fast-fail'],
  )
  assertOptionalInteger(
    concurrency.postProcessStartTimeoutMs,
    'concurrency.postProcessStartTimeoutMs',
    1,
  )
  assertOptionalNonEmptyString(concurrency.lockDir, 'concurrency.lockDir')
}

const validateArtifacts = (value: unknown): void => {
  const artifacts = readOptionalOptionObject(value, 'artifacts')
  if (!artifacts) {
    return
  }

  assertKnownOptions(artifacts, 'artifacts', ['naming'])
  const naming = readOptionalOptionObject(artifacts.naming, 'artifacts.naming')
  if (!naming) {
    return
  }

  assertKnownOptions(naming, 'artifacts.naming', [
    'style',
    'maxLength',
    'overflow',
  ])
  assertOptionalEnum(naming.style, 'artifacts.naming.style', [
    'test',
    'test-full',
    'session',
    'session-full',
  ])
  assertOptionalInteger(naming.maxLength, 'artifacts.naming.maxLength', 1)
  assertOptionalEnum(naming.overflow, 'artifacts.naming.overflow', [
    'truncate',
    'session',
  ])
}

const validateIntegrations = (value: unknown): void => {
  const integrations = readOptionalOptionObject(value, 'integrations')
  if (!integrations) {
    return
  }

  assertKnownOptions(integrations, 'integrations', ['allure'])
  const allure = readOptionalOptionObject(
    integrations.allure,
    'integrations.allure',
  )
  if (!allure) {
    return
  }

  assertKnownOptions(allure, 'integrations.allure', ['attach', 'maxBytes'])
  assertOptionalEnum(allure.attach, 'integrations.allure.attach', [
    'failures',
    'retained',
  ])
  assertOptionalInteger(allure.maxBytes, 'integrations.allure.maxBytes', 1)
}

const validateIntegrationCompatibility = (root: OptionRecord): void => {
  const integrations = root.integrations as OptionRecord | undefined
  if (integrations?.allure === undefined) {
    return
  }

  const recording = root.recording as OptionRecord | undefined
  if (recording?.scope === 'spec') {
    throw new TypeError(
      '[WdioPuppeteerVideoService] integrations.allure requires recording.scope to be "test" so attachments are associated with the active Allure test.',
    )
  }

  const processing = root.processing as OptionRecord | undefined
  const profile = root.profile ?? 'default'
  const timing =
    processing?.timing ?? (profile === 'ci' ? 'after-worker' : 'after-test')
  if (timing !== 'after-test') {
    throw new TypeError(
      '[WdioPuppeteerVideoService] integrations.allure requires processing.timing to be "after-test" so final media exists while the Allure test is active.',
    )
  }
}

const assertKnownRootOptions = (options: OptionRecord): void => {
  for (const key of Object.keys(options).sort((left, right) =>
    left.localeCompare(right),
  )) {
    if ((ROOT_OPTIONS as readonly string[]).includes(key)) {
      continue
    }

    const migration = BETA_OPTION_MIGRATIONS[key]
    if (migration) {
      throw new TypeError(
        `[WdioPuppeteerVideoService] Configuration option "${key}" was removed in 1.0. Use "${migration}" instead. Deprecated 0.8 aliases are not accepted.`,
      )
    }

    throw new TypeError(
      `[WdioPuppeteerVideoService] Unknown configuration option "${key}". Supported top-level options: ${ROOT_OPTIONS.join(', ')}.`,
    )
  }
}

const assertKnownOptions = (
  options: OptionRecord,
  path: string,
  allowed: readonly string[],
): void => {
  for (const key of Object.keys(options).sort((left, right) =>
    left.localeCompare(right),
  )) {
    if (!allowed.includes(key)) {
      const supported = allowed.length > 0 ? allowed.join(', ') : '(none yet)'
      throw new TypeError(
        `[WdioPuppeteerVideoService] Unknown configuration option "${path}.${key}". Supported options in "${path}": ${supported}.`,
      )
    }
  }
}

const requireOptionObject = (value: unknown, path: string): OptionRecord => {
  if (!isPlainObject(value)) {
    throw new TypeError(
      `[WdioPuppeteerVideoService] Configuration option "${path}" must be a plain object.`,
    )
  }
  return value
}

const readOptionalOptionObject = (
  value: unknown,
  path: string,
): OptionRecord | undefined => {
  if (value === undefined) {
    return undefined
  }
  return requireOptionObject(value, path)
}

const isPlainObject = (value: unknown): value is OptionRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const assertOptionalEnum = (
  value: unknown,
  path: string,
  allowed: readonly string[],
): void => {
  if (value === undefined) {
    return
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new TypeError(
      `[WdioPuppeteerVideoService] Configuration option "${path}" must be one of: ${allowed.join(', ')}.`,
    )
  }
}

const assertOptionalBoolean = (value: unknown, path: string): void => {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new TypeError(
      `[WdioPuppeteerVideoService] Configuration option "${path}" must be a boolean.`,
    )
  }
}

const assertOptionalInteger = (
  value: unknown,
  path: string,
  minimum: number,
  maximum?: number,
): void => {
  if (value === undefined) {
    return
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < minimum ||
    (maximum !== undefined && value > maximum)
  ) {
    const maximumSuffix =
      maximum === undefined
        ? ''
        : ` and less than or equal to ${maximum.toString()}`
    throw new TypeError(
      `[WdioPuppeteerVideoService] Configuration option "${path}" must be an integer greater than or equal to ${minimum.toString()}${maximumSuffix}.`,
    )
  }
}

const assertRequiredInteger = (
  value: unknown,
  path: string,
  minimum: number,
): void => {
  if (value === undefined) {
    throw new TypeError(
      `[WdioPuppeteerVideoService] Configuration option "${path}" is required.`,
    )
  }
  assertOptionalInteger(value, path, minimum)
}

const assertOptionalPositiveNumber = (value: unknown, path: string): void => {
  if (value === undefined) {
    return
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(
      `[WdioPuppeteerVideoService] Configuration option "${path}" must be a finite number greater than 0.`,
    )
  }
}

const assertOptionalNonEmptyString = (value: unknown, path: string): void => {
  if (value === undefined) {
    return
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(
      `[WdioPuppeteerVideoService] Configuration option "${path}" must be a non-empty string.`,
    )
  }
}

const assertOptionalStringArray = (value: unknown, path: string): void => {
  if (value === undefined) {
    return
  }
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) => typeof entry !== 'string' || entry.trim().length === 0,
    )
  ) {
    throw new TypeError(
      `[WdioPuppeteerVideoService] Configuration option "${path}" must be an array of non-empty strings.`,
    )
  }
}
