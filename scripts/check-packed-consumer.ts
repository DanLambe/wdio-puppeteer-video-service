import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

interface PackageExportTarget {
  import?: unknown
  types?: unknown
}

interface PackageMetadata {
  exports?: unknown
  files?: unknown
  name?: unknown
  type?: unknown
  version?: unknown
}

const EXPECTED_EXPORTS = new Map([
  ['.', ['./build/index.d.ts', './build/index.js']],
  ['./manifest', ['./build/manifest.d.ts', './build/manifest.js']],
  ['./reporter', ['./build/reporter.d.ts', './build/reporter.js']],
])

export const assertPackageMetadata = (value: unknown): void => {
  if (!isRecord(value)) {
    throw new TypeError('Packed package metadata must be an object')
  }
  const metadata = value as PackageMetadata
  if (metadata.type !== 'module') {
    throw new Error('Packed package must remain ESM-only')
  }
  if (!isRecord(metadata.exports)) {
    throw new Error('Packed package must define an export map')
  }

  const exportNames = Object.keys(metadata.exports).sort()
  if (exportNames.join(',') !== [...EXPECTED_EXPORTS.keys()].sort().join(',')) {
    throw new Error(`Unexpected package exports: ${exportNames.join(', ')}`)
  }

  for (const [exportName, [typesPath, importPath]] of EXPECTED_EXPORTS) {
    const target = metadata.exports[exportName] as PackageExportTarget
    if (target.types !== typesPath || target.import !== importPath) {
      throw new Error(
        `Invalid ${exportName} export target: ${JSON.stringify(target)}`,
      )
    }
    if ('require' in target) {
      throw new Error(`${exportName} must not expose a CommonJS target`)
    }
  }
}

export const parsePackResult = (output: string): string => {
  const result = JSON.parse(output) as unknown
  const packMetadata = Array.isArray(result)
    ? result[0]
    : isRecord(result)
      ? Object.values(result)[0]
      : undefined
  if (!isRecord(packMetadata)) {
    throw new Error('npm pack did not return package metadata')
  }
  const filename = packMetadata.filename
  if (typeof filename !== 'string' || !filename.endsWith('.tgz')) {
    throw new Error('npm pack did not return a tarball filename')
  }
  return filename
}

const runChecked = (command: string, args: string[], cwd: string): string => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0 || result.error) {
    throw new Error(
      `Command failed: ${command} ${args.join(' ')}\n${result.stderr}`,
      { cause: result.error },
    )
  }
  return result.stdout
}

const resolveNpmCli = (): string => {
  const npmCli = process.env.npm_execpath
  if (!npmCli) {
    throw new Error('npm_execpath is required; run through an npm script')
  }
  return npmCli
}

export const checkPackedConsumer = async (): Promise<void> => {
  const repositoryRoot = path.resolve(import.meta.dirname, '..')
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-video-pack-'))
  const consumerDir = path.join(tempDir, 'consumer')
  try {
    const npmCli = resolveNpmCli()
    const packOutput = runChecked(
      process.execPath,
      [
        npmCli,
        'pack',
        '--json',
        '--ignore-scripts',
        '--allow-directory=all',
        '--pack-destination',
        tempDir,
      ],
      repositoryRoot,
    )
    const tarballPath = path.join(tempDir, parsePackResult(packOutput))
    const attwEntryPoint = path.join(
      repositoryRoot,
      'node_modules',
      '@arethetypeswrong',
      'cli',
      'dist',
      'index.js',
    )
    runChecked(
      process.execPath,
      [attwEntryPoint, tarballPath, '--profile', 'esm-only'],
      repositoryRoot,
    )

    await fs.mkdir(consumerDir)
    await Promise.all(
      ['package.json', 'consumer.mjs'].map((fileName) =>
        fs.copyFile(
          path.join(repositoryRoot, 'tests', 'packed-consumer', fileName),
          path.join(consumerDir, fileName),
        ),
      ),
    )
    runChecked(
      process.execPath,
      [
        npmCli,
        'install',
        tarballPath,
        '--ignore-scripts',
        '--legacy-peer-deps',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
      ],
      consumerDir,
    )

    const installedRoot = path.join(
      consumerDir,
      'node_modules',
      'wdio-puppeteer-video-service',
    )
    const metadata = JSON.parse(
      await fs.readFile(path.join(installedRoot, 'package.json'), 'utf8'),
    ) as unknown
    assertPackageMetadata(metadata)
    await assertPackedFiles(installedRoot)
    runChecked(process.execPath, ['consumer.mjs'], consumerDir)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

const assertPackedFiles = async (packageRoot: string): Promise<void> => {
  for (const [, targets] of EXPECTED_EXPORTS) {
    for (const target of targets) {
      await fs.access(path.join(packageRoot, target.slice(2)))
    }
  }
  for (const documentation of [
    'CHANGELOG.md',
    'LICENSE',
    'MIGRATION.md',
    'README.md',
    'RELEASING.md',
    'SUPPORT.md',
    'TROUBLESHOOTING.md',
  ]) {
    await fs.access(path.join(packageRoot, documentation))
  }

  const sourceFiles = await listFiles(packageRoot)
  const rawTypeScript = sourceFiles.filter(
    (fileName) => fileName.endsWith('.ts') && !fileName.endsWith('.d.ts'),
  )
  if (rawTypeScript.length > 0) {
    throw new Error(`Packed raw TypeScript files: ${rawTypeScript.join(', ')}`)
  }
}

const listFiles = async (directory: string): Promise<string[]> => {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)))
    } else {
      files.push(entryPath)
    }
  }
  return files
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isExecutedDirectly = (() => {
  const argvPath = process.argv[1]
  return argvPath ? import.meta.url === pathToFileURL(argvPath).href : false
})()

if (isExecutedDirectly) {
  await checkPackedConsumer()
}
