import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isVideoManifest, type VideoManifestV1 } from '../manifest.js'
import { readReporterFragments } from './fragments.js'
import { renderStaticVideoReport } from './html-renderer.js'
import { createReportModel } from './report-model.js'
import type { ReporterDiagnostic } from './types.js'

const MANIFEST_FILE_NAME = 'manifest.json'

export interface GenerateVideoReportOptions {
  readonly outputDir: string
  readonly runId: string
  readonly manifest?: unknown
}

export interface GeneratedVideoReport {
  readonly path: string
  readonly itemCount: number
  readonly diagnosticCount: number
}

interface ResolvedManifest {
  readonly manifest?: VideoManifestV1
  readonly diagnostics: ReporterDiagnostic[]
}

export const generateVideoReportForRun = async (
  options: GenerateVideoReportOptions,
): Promise<GeneratedVideoReport | undefined> => {
  const outputDir = path.resolve(options.outputDir)
  const { fragments, invalidFiles } = await readReporterFragments(
    outputDir,
    options.runId,
  )
  if (fragments.length === 0 && invalidFiles.length === 0) {
    return undefined
  }

  const diagnostics = invalidFiles.map<ReporterDiagnostic>((fileName) => ({
    code: 'invalid-reporter-fragment',
    message: `Ignored invalid reporter fragment: ${fileName}`,
  }))
  const resolvedManifest = await resolveManifest(outputDir, options.manifest)
  diagnostics.push(...resolvedManifest.diagnostics)
  const run = resolvedManifest.manifest?.runs.find(
    (candidate) => candidate.id === options.runId,
  )
  if (resolvedManifest.manifest && !run) {
    diagnostics.push({
      code: 'missing-manifest-run',
      message: `Manifest v1 does not contain run ${options.runId}`,
    })
  }

  const model = await createReportModel({
    outputDir,
    runId: options.runId,
    fragments,
    run,
    initialDiagnostics: diagnostics,
  })
  const reportFileName = fragments[0]?.reportFileName ?? 'video-report.html'
  const reportPath = path.join(outputDir, reportFileName)
  await writeReportAtomically(reportPath, renderStaticVideoReport(model))
  return {
    path: reportPath,
    itemCount: model.items.length,
    diagnosticCount: model.diagnostics.length,
  }
}

const resolveManifest = async (
  outputDir: string,
  suppliedManifest: unknown,
): Promise<ResolvedManifest> => {
  if (suppliedManifest !== undefined) {
    return validateManifestValue(suppliedManifest)
  }
  try {
    const manifestValue = JSON.parse(
      await fs.readFile(path.join(outputDir, MANIFEST_FILE_NAME), 'utf8'),
    ) as unknown
    return validateManifestValue(manifestValue)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        diagnostics: [
          {
            code: 'missing-manifest',
            message:
              'manifest.json was not found; test outcomes have no video associations',
          },
        ],
      }
    }
    return {
      diagnostics: [
        {
          code: 'invalid-manifest',
          message:
            'manifest.json could not be parsed; test outcomes have no video associations',
        },
      ],
    }
  }
}

const validateManifestValue = (value: unknown): ResolvedManifest => {
  if (isVideoManifest(value)) {
    return { manifest: value, diagnostics: [] }
  }
  return {
    diagnostics: [
      {
        code: 'invalid-manifest',
        message: 'manifest.json is not a valid Manifest v1 document',
      },
    ],
  }
}

const writeReportAtomically = async (
  reportPath: string,
  content: string,
): Promise<void> => {
  await fs.mkdir(path.dirname(reportPath), { recursive: true })
  const temporaryPath = `${reportPath}.${randomUUID()}.tmp`
  await fs.writeFile(temporaryPath, content, 'utf8')
  await fs.rename(temporaryPath, reportPath)
}

export { renderStaticVideoReport } from './html-renderer.js'
