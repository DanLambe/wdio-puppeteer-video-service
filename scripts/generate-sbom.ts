import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

interface CycloneDxBom {
  bomFormat?: unknown
  metadata?: {
    component?: {
      name?: unknown
      type?: unknown
      version?: unknown
    }
  }
  specVersion?: unknown
}

export const assertCycloneDxBom = (
  value: unknown,
  expectedPackage: { name: string; version: string },
): void => {
  if (!isRecord(value)) {
    throw new TypeError('SBOM must be a JSON object')
  }
  const bom = value as CycloneDxBom
  const component = bom.metadata?.component
  if (bom.bomFormat !== 'CycloneDX' || typeof bom.specVersion !== 'string') {
    throw new Error('npm did not generate a valid CycloneDX SBOM')
  }
  if (
    component?.type !== 'library' ||
    component.name !== expectedPackage.name ||
    component.version !== expectedPackage.version
  ) {
    throw new Error('SBOM metadata does not match the package being released')
  }
}

export const generateSbom = async (outputPath: string): Promise<void> => {
  const repositoryRoot = path.resolve(import.meta.dirname, '..')
  const packageMetadata = JSON.parse(
    await fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
  ) as { name: string; version: string }
  const npmCli = process.env.npm_execpath
  if (!npmCli) {
    throw new Error('npm_execpath is required; run through an npm script')
  }

  const result = spawnSync(
    process.execPath,
    [
      npmCli,
      'sbom',
      '--package-lock-only',
      '--omit=dev',
      '--sbom-format=cyclonedx',
      '--sbom-type=library',
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
    },
  )
  if (result.status !== 0 || result.error) {
    throw new Error(`npm sbom failed: ${result.stderr}`, {
      cause: result.error,
    })
  }

  const bom = JSON.parse(result.stdout) as unknown
  assertCycloneDxBom(bom, packageMetadata)
  const absoluteOutputPath = resolveReleaseOutputPath(
    repositoryRoot,
    outputPath,
  )
  const temporaryPath = `${absoluteOutputPath}.${process.pid.toString()}.tmp`
  await fs.writeFile(temporaryPath, `${JSON.stringify(bom, null, 2)}\n`, 'utf8')
  await fs.rename(temporaryPath, absoluteOutputPath)
}

export const resolveReleaseOutputPath = (
  repositoryRoot: string,
  outputPath: string,
): string => {
  const resolvedRoot = path.resolve(repositoryRoot)
  const resolvedOutput = path.resolve(resolvedRoot, outputPath)
  const relativeOutput = path.relative(resolvedRoot, resolvedOutput)
  if (
    relativeOutput.length === 0 ||
    relativeOutput === '..' ||
    relativeOutput.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeOutput)
  ) {
    throw new TypeError('SBOM output path must be inside the repository')
  }
  return resolvedOutput
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isExecutedDirectly = (() => {
  const argvPath = process.argv[1]
  return argvPath ? import.meta.url === pathToFileURL(argvPath).href : false
})()

if (isExecutedDirectly) {
  const outputPath = process.argv[2]?.trim() || 'sbom.cdx.json'
  await generateSbom(outputPath)
}
