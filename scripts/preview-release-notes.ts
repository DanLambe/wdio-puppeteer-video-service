import { readFileSync } from 'node:fs'
import { generateReleaseNotes } from './generate-release-notes.js'
import { runGit } from './git-utils.js'

interface PackageJson {
  version?: string
}

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageJson

const version = packageJson.version?.trim()
if (!version) {
  throw new Error('Unable to determine package version from package.json')
}

const latestTag = runGit(['tag', '--list', 'v*', '--sort=-version:refname'])
  .split(/\r?\n/)
  .map((line) => line.trim())
  .find((line) => line.length > 0)

const commitRange = latestTag ? `${latestTag}..HEAD` : 'HEAD'
console.log(generateReleaseNotes(version, commitRange))
