import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const requireObject = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

const requireVersion = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must contain a non-empty version string`)
  }
  return value
}

/** Check by default; synchronization changes only the lockfile's root versions. */
export const checkReleaseVersion = async (
  directory: string,
  synchronize = false,
): Promise<string> => {
  const lockPath = path.join(directory, 'package-lock.json')
  const [packageText, lockText] = await Promise.all([
    fs.readFile(path.join(directory, 'package.json'), 'utf8'),
    fs.readFile(lockPath, 'utf8'),
  ])
  const packageJson = requireObject(JSON.parse(packageText), 'package.json')
  const lock = requireObject(JSON.parse(lockText), 'package-lock.json')
  const packages = requireObject(lock.packages, 'package-lock.json packages')
  const rootPackage = requireObject(
    packages[''],
    'package-lock.json packages[""]',
  )
  const version = requireVersion(packageJson.version, 'package.json')
  const lockVersion = requireVersion(lock.version, 'package-lock.json')
  const rootVersion = requireVersion(
    rootPackage.version,
    'package-lock.json packages[""]',
  )

  if (lockVersion === version && rootVersion === version) {
    return version
  }
  if (!synchronize) {
    throw new Error(
      `Release version mismatch: package.json=${version}, package-lock.json=${lockVersion}, packages[""]=${rootVersion}. Run node scripts/check-release-version.ts --sync after versioning.`,
    )
  }

  // No dependency resolution: preserve every dependency entry exactly as data.
  lock.version = version
  rootPackage.version = version
  await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
  return version
}

const argvPath = process.argv[1]
if (argvPath && import.meta.url === pathToFileURL(argvPath).href) {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--sync')) {
    throw new TypeError('Usage: check-release-version.ts [--sync]')
  }
  const version = await checkReleaseVersion(process.cwd(), args[0] === '--sync')
  process.stdout.write(`Package and lockfile versions match: ${version}\n`)
}
