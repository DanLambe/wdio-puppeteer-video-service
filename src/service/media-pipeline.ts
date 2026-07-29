import type { FailurePolicy } from '../types.js'
import { publishAtomicArtifact } from './artifact-integrity.js'
import type { FileSystemBoundary, ProcessBoundary } from './boundaries.js'
import type { MergeExecutionOptions } from './constants.js'
import type { ServiceLogger } from './logging.js'
import {
  buildH264TranscodeArgs,
  buildMediaValidationArgs,
  mergeSegmentPathsToOutput,
} from './post-process.js'

export interface MediaPipelineRuntime {
  run(args: string[], operation: string): Promise<boolean>
  withPostProcessSlot<T>(
    operation: string,
    task: () => Promise<T>,
  ): Promise<T | undefined>
}

export interface MediaPipelineOptions {
  readonly failurePolicy: FailurePolicy
  readonly fileSystem: FileSystemBoundary
  readonly log: ServiceLogger
  readonly outputDir: string
  readonly process: ProcessBoundary
  readonly runtime: MediaPipelineRuntime
}

export interface TranscodeRequest {
  readonly deleteOriginal: boolean
  readonly ffmpegArgs?: readonly string[]
  readonly inputPath: string
  readonly outputPath: string
}

export class MediaPipeline {
  private readonly failurePolicy: FailurePolicy
  private readonly fileSystem: FileSystemBoundary
  private readonly log: ServiceLogger
  private readonly outputDir: string
  private readonly process: ProcessBoundary
  private readonly runtime: MediaPipelineRuntime

  constructor(options: MediaPipelineOptions) {
    this.failurePolicy = options.failurePolicy
    this.fileSystem = options.fileSystem
    this.log = options.log
    this.outputDir = options.outputDir
    this.process = options.process
    this.runtime = options.runtime
  }

  async transcode(options: TranscodeRequest): Promise<string | undefined> {
    const publishedPath = await this.runtime.withPostProcessSlot(
      'transcode',
      () =>
        publishAtomicArtifact({
          desiredPath: options.outputPath,
          process: this.process,
          produce: (temporaryPath) =>
            this.runtime.run(
              buildH264TranscodeArgs(
                options.inputPath,
                temporaryPath,
                options.ffmpegArgs === undefined
                  ? undefined
                  : [...options.ffmpegArgs],
              ),
              'transcode',
            ),
          validate: (temporaryPath) =>
            this.runtime.run(
              buildMediaValidationArgs(temporaryPath),
              'transcode validation',
            ),
          warn: (message) => {
            this.log('warn', message)
          },
        }),
    )
    if (!publishedPath) {
      return undefined
    }

    if (options.deleteOriginal && options.inputPath !== publishedPath) {
      await this.fileSystem.unlink(options.inputPath).catch(() => {
        /* best-effort source cleanup after verified publication */
      })
    }
    return publishedPath
  }

  async merge(options: MergeExecutionOptions): Promise<string | undefined> {
    return this.runtime.withPostProcessSlot(options.ffmpegOperation, () =>
      mergeSegmentPathsToOutput({
        ...options,
        outputDir: this.outputDir,
        runFfmpeg: (args, operation) => this.runtime.run(args, operation),
        warn: (message) => {
          this.log('warn', message)
        },
      }),
    )
  }

  reportFailure(message: string, alreadyLogged = false): void {
    if (!alreadyLogged) {
      this.log('warn', `[WdioPuppeteerVideoService] ${message}`)
    }
    if (this.failurePolicy === 'error') {
      throw new Error(`[WdioPuppeteerVideoService] ${message}`)
    }
  }
}
