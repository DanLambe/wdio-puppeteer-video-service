import fs from 'node:fs/promises'
import path from 'node:path'
import type { LogLevel } from '../types.js'

export interface AllureAttachmentApi {
  addAttachment(
    name: string,
    content: Buffer,
    type: string,
  ): Promise<void> | void
}

export interface AllureModule {
  default?: unknown
  addAttachment?: unknown
}

export type AllureModuleLoader = () => Promise<AllureModule>

export interface AllureVideoIntegrationOptions {
  attach: 'failures' | 'retained'
  maxBytes?: number
}

export interface AllureAttachmentResult {
  attachedPaths: string[]
  error?: Error
}

interface AllureAttachmentFailure extends AllureAttachmentResult {
  error: Error
}

type IntegrationLogger = (
  level: LogLevel,
  message: string,
  details?: unknown,
) => void

type ReadVideo = (filePath: string) => Promise<Buffer>
type ReadVideoSize = (filePath: string) => Promise<number>

const MIME_TYPES = new Map([
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
])

const loadAllureModule: AllureModuleLoader = () =>
  import('@wdio/allure-reporter')

const readVideo: ReadVideo = (filePath) => fs.readFile(filePath)
const readVideoSize: ReadVideoSize = async (filePath) => {
  return (await fs.stat(filePath)).size
}

export class AllureVideoIntegration {
  private apiTask: Promise<AllureAttachmentApi> | undefined
  private readonly options: AllureVideoIntegrationOptions
  private readonly log: IntegrationLogger
  private readonly loadModule: AllureModuleLoader
  private readonly readFile: ReadVideo
  private readonly readFileSize: ReadVideoSize

  constructor(
    options: AllureVideoIntegrationOptions,
    log: IntegrationLogger,
    loadModule: AllureModuleLoader = loadAllureModule,
    readFile: ReadVideo = readVideo,
    readFileSize: ReadVideoSize = readVideoSize,
  ) {
    this.options = options
    this.log = log
    this.loadModule = loadModule
    this.readFile = readFile
    this.readFileSize = readFileSize
  }

  async attachRetainedVideos(
    paths: readonly string[],
    passed: boolean,
  ): Promise<AllureAttachmentResult> {
    if (passed && this.options.attach === 'failures') {
      return { attachedPaths: [] }
    }

    const supportedMedia = paths.flatMap((filePath) => {
      const mimeType = MIME_TYPES.get(path.extname(filePath).toLowerCase())
      return mimeType ? [{ filePath, mimeType }] : []
    })
    if (supportedMedia.length === 0) {
      return { attachedPaths: [] }
    }

    let api: AllureAttachmentApi
    try {
      api = await this.getApi()
    } catch (error) {
      return this.failure(
        'Unable to load optional peer @wdio/allure-reporter',
        error,
      )
    }

    const attachedPaths: string[] = []
    let firstError: Error | undefined
    for (const [index, media] of supportedMedia.entries()) {
      const { filePath, mimeType } = media
      try {
        if (this.options.maxBytes !== undefined) {
          const fileSize = await this.readFileSize(filePath)
          if (fileSize > this.options.maxBytes) {
            this.log(
              'warn',
              `[WdioPuppeteerVideoService] Skipped Allure video attachment ${filePath}: ${fileSize.toString()} bytes exceeds integrations.allure.maxBytes (${this.options.maxBytes.toString()}).`,
            )
            continue
          }
        }

        const content = await this.readFile(filePath)
        const partLabel =
          supportedMedia.length > 1
            ? ` (${(index + 1).toString()}/${supportedMedia.length.toString()})`
            : ''
        await api.addAttachment(
          `Video${partLabel}: ${path.basename(filePath)}`,
          content,
          mimeType,
        )
        attachedPaths.push(filePath)
      } catch (error) {
        const result = this.failure(
          `Failed to attach retained video ${filePath} to Allure`,
          error,
        )
        firstError ??= result.error
      }
    }

    return firstError ? { attachedPaths, error: firstError } : { attachedPaths }
  }

  private getApi(): Promise<AllureAttachmentApi> {
    this.apiTask ??= this.loadModule().then((module) => {
      const candidate = resolveAllureApi(module)
      if (!candidate) {
        throw new TypeError(
          '@wdio/allure-reporter does not expose addAttachment',
        )
      }
      return candidate
    })
    return this.apiTask
  }

  private failure(message: string, cause: unknown): AllureAttachmentFailure {
    const error = new Error(`[WdioPuppeteerVideoService] ${message}.`, {
      cause,
    })
    this.log('warn', error.message, cause)
    return { attachedPaths: [], error }
  }
}

const resolveAllureApi = (
  module: AllureModule,
): AllureAttachmentApi | undefined => {
  if (hasAddAttachment(module.default)) {
    return module.default
  }
  if (hasAddAttachment(module)) {
    return module
  }
  return undefined
}

const hasAddAttachment = (value: unknown): value is AllureAttachmentApi => {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'addAttachment' in value &&
    typeof value.addAttachment === 'function'
  )
}
