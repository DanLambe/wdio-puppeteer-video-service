import { pathToFileURL } from 'node:url'
import semver from 'semver'

export type ReleaseChannel = 'prerelease' | 'stable'
export type ReleaseDistTag = 'latest' | 'next'

export const resolveReleaseDistTag = (
  version: string,
  channel: string,
): ReleaseDistTag => {
  if (!semver.valid(version)) {
    throw new TypeError(`Invalid package version: ${version}`)
  }
  const isPrerelease = semver.prerelease(version) !== null
  if (channel === 'prerelease') {
    if (!isPrerelease) {
      throw new Error(
        `Prerelease publishing requires a prerelease package version; refusing ${version}.`,
      )
    }
    return 'next'
  }
  if (channel === 'stable') {
    if (isPrerelease) {
      throw new Error(
        `Stable publishing cannot use prerelease package version ${version}.`,
      )
    }
    return 'latest'
  }
  throw new TypeError(`Unsupported release channel: ${channel}`)
}

const isExecutedDirectly = (() => {
  const argvPath = process.argv[1]
  return argvPath ? import.meta.url === pathToFileURL(argvPath).href : false
})()

if (isExecutedDirectly) {
  const version = process.argv[2]
  const channel = process.argv[3]
  if (!version || !channel) {
    throw new TypeError(
      'Usage: resolve-release-channel.ts <package-version> <release-channel>',
    )
  }
  process.stdout.write(resolveReleaseDistTag(version, channel))
}
