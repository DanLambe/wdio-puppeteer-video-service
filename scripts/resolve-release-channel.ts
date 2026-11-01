import { pathToFileURL } from 'node:url'
import semver from 'semver'

export type ReleaseChannel = 'prerelease' | 'stable'
export type ReleaseDistTag = 'latest' | 'next' | 'wdio9'

interface MaintenanceLine {
  readonly branch: string
  readonly distTag: ReleaseDistTag
}

// An older major still maintained publishes stable releases from its own
// branch under its own npm tag, so they never move `latest`. Every other major
// publishes from master.
const MAINTENANCE_LINES: Readonly<Partial<Record<number, MaintenanceLine>>> = {
  1: { branch: 'release/1.x', distTag: 'wdio9' },
}

export const resolveReleaseDistTag = (
  version: string,
  channel: string,
  branch = 'master',
): ReleaseDistTag => {
  if (!semver.valid(version)) {
    throw new TypeError(`Invalid package version: ${version}`)
  }
  const isPrerelease = semver.prerelease(version) !== null
  const maintenance = MAINTENANCE_LINES[semver.major(version)]
  if (maintenance) {
    if (branch !== maintenance.branch) {
      throw new Error(
        `Version ${version} is published from ${maintenance.branch}; refusing to publish it from ${branch}.`,
      )
    }
    if (channel !== 'stable' || isPrerelease) {
      throw new Error(
        `${maintenance.branch} publishes stable versions on the stable channel only; refusing ${version} on ${channel}.`,
      )
    }
    return maintenance.distTag
  }
  if (branch !== 'master') {
    throw new Error(
      `Version ${version} is published from master; refusing to publish it from ${branch}.`,
    )
  }
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
  const branch = process.argv[4]
  if (!version || !channel || !branch) {
    throw new TypeError(
      'Usage: resolve-release-channel.ts <package-version> <release-channel> <branch>',
    )
  }
  process.stdout.write(resolveReleaseDistTag(version, channel, branch))
}
