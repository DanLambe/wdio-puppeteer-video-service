import { readFileSync } from 'node:fs'
import semver from 'semver'
import { runGit } from './git-utils.js'

interface PackageJson {
  version?: string
}

const readVersion = (packageJsonContents: string, source: string): string => {
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

const baseRef = process.argv[2]?.trim()

if (!baseRef) {
  throw new Error('Usage: tsx scripts/check-version-bump.ts <base-git-ref>')
}

const currentVersion = readVersion(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  'package.json',
)
const baseVersion = readVersion(
  runGit(['show', `${baseRef}:package.json`]),
  `${baseRef}:package.json`,
)

if (!semver.gt(currentVersion, baseVersion)) {
  throw new Error(
    `package.json version must be greater than the base version (${baseVersion}). Current version: ${currentVersion}`,
  )
}

console.log(`Version bump check passed: ${baseVersion} -> ${currentVersion}`)
