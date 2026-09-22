import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkReleaseVersion } from '../../scripts/check-release-version.js'

const scriptPath = path.resolve('scripts/check-release-version.ts')

describe('release version consistency', () => {
  let directory: string
  let lockPath: string

  const writeFixture = async (
    version: unknown = '1.0.0-rc.5',
    lockVersion: unknown = version,
    rootVersion: unknown = version,
  ): Promise<void> => {
    await fs.writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: 'example', version }),
    )
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        name: 'example',
        version: lockVersion,
        lockfileVersion: 3,
        packages: {
          '': {
            name: 'example',
            version: rootVersion,
            devDependencies: { example: '^2.0.0' },
          },
          'node_modules/example': {
            version: '2.1.0',
            integrity: 'retained-fixture-value',
          },
        },
      }),
    )
  }

  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'release-version-test-'),
    )
    lockPath = path.join(directory, 'package-lock.json')
  })

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true })
  })

  it.each(['1.0.0-rc.5', '1.0.0'])(
    'accepts matching versions for %s without rewriting',
    async (version) => {
      await writeFixture(version)
      const original = await fs.readFile(lockPath, 'utf8')
      await expect(checkReleaseVersion(directory)).resolves.toBe(version)
      await expect(checkReleaseVersion(directory, true)).resolves.toBe(version)
      expect(await fs.readFile(lockPath, 'utf8')).toBe(original)
    },
  )

  it.each([
    ['1.0.0-rc.4', '1.0.0-rc.5'],
    ['1.0.0-rc.5', '1.0.0-rc.4'],
    ['1.0.0-rc.4', '1.0.0-rc.4'],
  ])(
    'rejects stale lock versions %s / %s without silently repairing them',
    async (lockVersion, rootVersion) => {
      await writeFixture('1.0.0-rc.5', lockVersion, rootVersion)
      const original = await fs.readFile(lockPath, 'utf8')
      await expect(checkReleaseVersion(directory)).rejects.toThrow(
        'Release version mismatch',
      )
      expect(await fs.readFile(lockPath, 'utf8')).toBe(original)
    },
  )

  it('synchronizes only root version metadata and is idempotent', async () => {
    await writeFixture('1.0.0-rc.5', '1.0.0-rc.4', '1.0.0-rc.4')
    const original = JSON.parse(await fs.readFile(lockPath, 'utf8'))
    const packageText = await fs.readFile(
      path.join(directory, 'package.json'),
      'utf8',
    )
    await expect(checkReleaseVersion(directory, true)).resolves.toBe(
      '1.0.0-rc.5',
    )
    original.version = '1.0.0-rc.5'
    original.packages[''].version = '1.0.0-rc.5'
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8'))).toEqual(original)
    expect(
      await fs.readFile(path.join(directory, 'package.json'), 'utf8'),
    ).toBe(packageText)
    await expect(checkReleaseVersion(directory)).resolves.toBe('1.0.0-rc.5')
    const synchronized = await fs.readFile(lockPath, 'utf8')
    await checkReleaseVersion(directory, true)
    expect(await fs.readFile(lockPath, 'utf8')).toBe(synchronized)
  })

  it.each([null, 5, '', ' '])(
    'rejects invalid package versions (%s) before syncing',
    async (version) => {
      await writeFixture(version)
      const original = await fs.readFile(lockPath, 'utf8')
      await expect(checkReleaseVersion(directory, true)).rejects.toThrow(
        'version string',
      )
      expect(await fs.readFile(lockPath, 'utf8')).toBe(original)
    },
  )

  it.each([
    null,
    [],
    {},
    { version: '1.0.0-rc.4', packages: {} },
    { version: '1.0.0-rc.4', packages: { '': {} } },
    { packages: { '': { version: '1.0.0-rc.4' } } },
  ])(
    'rejects malformed lock metadata without replacing it: %j',
    async (lock) => {
      await writeFixture()
      const original = JSON.stringify(lock)
      await fs.writeFile(lockPath, original)
      await expect(checkReleaseVersion(directory, true)).rejects.toThrow(
        TypeError,
      )
      expect(await fs.readFile(lockPath, 'utf8')).toBe(original)
    },
  )

  it('fails on missing files and invalid JSON without creating a new lockfile', async () => {
    await writeFixture()
    await fs.writeFile(lockPath, '{')
    await expect(checkReleaseVersion(directory, true)).rejects.toThrow(
      SyntaxError,
    )
    expect(await fs.readFile(lockPath, 'utf8')).toBe('{')
    await fs.unlink(lockPath)
    await expect(checkReleaseVersion(directory, true)).rejects.toThrow('ENOENT')
    await expect(fs.access(lockPath)).rejects.toThrow('ENOENT')
  })

  it('runs the Node 24 CLI without installed dependencies and rejects unknown flags', async () => {
    await writeFixture('1.0.0-rc.5', '1.0.0-rc.4', '1.0.0-rc.4')
    const run = (args: string[]) =>
      spawnSync(process.execPath, [scriptPath, ...args], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10_000,
      })
    expect(run([]).status).toBe(1)
    expect(run(['--syn']).stderr).toContain('Usage:')
    expect(run(['--sync', 'unexpected']).status).toBe(1)
    const synchronized = run(['--sync'])
    expect(synchronized.status).toBe(0)
    expect(synchronized.stdout).toContain('1.0.0-rc.5')
    expect(run([]).status).toBe(0)
  })

  it('enforces synchronization after versioning and read-only checks before PR installs and packaging', async () => {
    const metadata = JSON.parse(await fs.readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>
    }
    const workflow = await fs.readFile(
      '.github/workflows/pull-request-checks.yaml',
      'utf8',
    )
    const releaseWorkflow = await fs.readFile(
      '.github/workflows/release-pr.yaml',
      'utf8',
    )
    expect(metadata.scripts['version-packages']).toBe(
      'changeset version && node scripts/check-release-version.ts --sync',
    )
    expect(metadata.scripts['check:release-version']).toBe(
      'node scripts/check-release-version.ts',
    )
    for (const command of ['prepack', 'package:check', 'release:check']) {
      expect(metadata.scripts[command]).toMatch(
        /^corepack npm run check:release-version && /u,
      )
    }
    expect(workflow).toContain('run: node scripts/check-release-version.ts')
    expect(
      workflow.indexOf('run: node scripts/check-release-version.ts'),
    ).toBeLessThan(workflow.indexOf('run: corepack npm ci'))
    expect(releaseWorkflow).toContain(
      'version: corepack npm run version-packages',
    )
  })
})
