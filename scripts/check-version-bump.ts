import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import semver from 'semver'
import { runGit } from './git-utils.js'

interface PackageJson {
  version?: string
}

export const readVersion = (
  packageJsonContents: string,
  source: string,
): string => {
  const packageJson = JSON.parse(packageJsonContents) as PackageJson
  const version = packageJson.version?.trim()

  if (!version) {
    throw new Error(`Unable to determine package version from ${source}`)
  }

  if (!semver.valid(version)) {
    throw new Error(`Invalid semver version "${version}" in ${source}`)
  }

  return version
}

export const assertVersionBump = (
  currentVersion: string,
  baseVersion: string,
): void => {
  if (!semver.gt(currentVersion, baseVersion)) {
    throw new Error(
      `package.json version must be greater than the base version (${baseVersion}). Current version: ${currentVersion}`,
    )
  }
}

interface CheckVersionBumpCliDependencies {
  log?: (message: string) => void
  readPackageJson?: (packageJsonUrl: URL, encoding: BufferEncoding) => string
  runGitCommand?: (args: string[]) => string
}

export const runCli = (
  dependencies: CheckVersionBumpCliDependencies = {},
): void => {
  const baseRef = process.argv[2]?.trim()
  const readPackageJson = dependencies.readPackageJson ?? readFileSync
  const runGitCommand = dependencies.runGitCommand ?? runGit
  const log = dependencies.log ?? console.log

  if (!baseRef) {
    throw new Error('Usage: tsx scripts/check-version-bump.ts <base-git-ref>')
  }

  const currentVersion = readVersion(
    readPackageJson(new URL('../package.json', import.meta.url), 'utf8'),
    'package.json',
  )
  const baseVersion = readVersion(
    runGitCommand(['show', `${baseRef}:package.json`]),
    `${baseRef}:package.json`,
  )

  assertVersionBump(currentVersion, baseVersion)
  log(`Version bump check passed: ${baseVersion} -> ${currentVersion}`)
}

const isExecutedDirectly = (() => {
  const argvPath = process.argv[1]
  if (!argvPath) {
    return false
  }

  return import.meta.url === pathToFileURL(argvPath).href
})()

if (isExecutedDirectly) {
  runCli()
}
