import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import semver from 'semver'
import { describe, expect, it } from 'vitest'
import {
  assertPackageMetadata,
  assertPackedSourceMaps,
  parsePackResult,
} from '../../scripts/check-packed-consumer.js'
import {
  assertCycloneDxBom,
  resolveReleaseOutputPath,
} from '../../scripts/generate-sbom.js'
import { resolveReleaseDistTag } from '../../scripts/resolve-release-channel.js'

describe('release package validation', () => {
  it('accepts the exact ESM export map', () => {
    expect(() =>
      assertPackageMetadata({
        type: 'module',
        exports: {
          '.': {
            types: './build/index.d.ts',
            import: './build/index.js',
          },
          './manifest': {
            types: './build/manifest.d.ts',
            import: './build/manifest.js',
          },
          './reporter': {
            types: './build/reporter.d.ts',
            import: './build/reporter.js',
          },
        },
      }),
    ).not.toThrow()
  })

  it('rejects CommonJS, missing, and unexpected export targets', () => {
    expect(() => assertPackageMetadata(null)).toThrow('must be an object')
    expect(() => assertPackageMetadata({ type: 'commonjs' })).toThrow(
      'ESM-only',
    )
    expect(() =>
      assertPackageMetadata({ type: 'module', exports: {} }),
    ).toThrow('Unexpected package exports')
    expect(() =>
      assertPackageMetadata({
        type: 'module',
        exports: {
          '.': {
            types: './build/index.d.ts',
            import: './build/index.js',
            require: './build/index.cjs',
          },
          './manifest': {
            types: './build/manifest.d.ts',
            import: './build/manifest.js',
          },
          './reporter': {
            types: './build/reporter.d.ts',
            import: './build/reporter.js',
          },
        },
      }),
    ).toThrow('CommonJS')
  })

  it('parses npm pack JSON and rejects malformed output', () => {
    expect(parsePackResult('[{"filename":"package-1.0.0.tgz"}]')).toBe(
      'package-1.0.0.tgz',
    )
    expect(
      parsePackResult(
        '{"wdio-puppeteer-video-service":{"filename":"package-1.0.0.tgz"}}',
      ),
    ).toBe('package-1.0.0.tgz')
    expect(() => parsePackResult('{}')).toThrow('package metadata')
    expect(() => parsePackResult('[{}]')).toThrow('tarball filename')
  })

  it('requires package versions to match the selected npm release channel', () => {
    expect(resolveReleaseDistTag('1.0.0-rc.2', 'prerelease')).toBe('next')
    expect(resolveReleaseDistTag('1.0.0', 'stable')).toBe('latest')
    expect(() => resolveReleaseDistTag('1.0.0', 'prerelease')).toThrow(
      'requires a prerelease package version',
    )
    expect(() => resolveReleaseDistTag('1.0.0-rc.2', 'stable')).toThrow(
      'cannot use prerelease package version',
    )
    expect(() => resolveReleaseDistTag('1.0.0', 'preview')).toThrow(
      'Unsupported release channel',
    )
    expect(() => resolveReleaseDistTag('not-semver', 'stable')).toThrow(
      'Invalid package version',
    )
  })

  it('requires packed source-map sources to be embedded or packaged', async () => {
    const packageRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'wdio-source-map-test-'),
    )
    const buildDir = path.join(packageRoot, 'build')
    const sourceDir = path.join(packageRoot, 'src')
    const mapPath = path.join(buildDir, 'index.js.map')
    try {
      await fs.mkdir(buildDir)
      await fs.writeFile(
        mapPath,
        JSON.stringify({
          sources: ['../src/index.ts'],
          sourcesContent: ['export const value = true'],
        }),
      )
      await expect(assertPackedSourceMaps(packageRoot)).resolves.toBeUndefined()

      await fs.mkdir(sourceDir)
      await fs.writeFile(path.join(sourceDir, 'index.ts'), 'export {}')
      await fs.writeFile(
        mapPath,
        JSON.stringify({ sources: ['../src/index.ts'] }),
      )
      await expect(assertPackedSourceMaps(packageRoot)).resolves.toBeUndefined()

      await fs.unlink(path.join(sourceDir, 'index.ts'))
      await expect(assertPackedSourceMaps(packageRoot)).rejects.toThrow(
        'neither embedded nor packaged',
      )

      await fs.writeFile(
        path.join(buildDir, 'index.d.ts.map'),
        JSON.stringify({ sources: ['../src/index.ts'] }),
      )
      await expect(assertPackedSourceMaps(packageRoot)).rejects.toThrow(
        'Packed declaration maps',
      )
    } finally {
      await fs.rm(packageRoot, { recursive: true, force: true })
    }
  })

  it('validates npm CycloneDX metadata', () => {
    const expectedPackage = { name: 'package', version: '1.0.0' }
    expect(() =>
      assertCycloneDxBom(
        {
          bomFormat: 'CycloneDX',
          specVersion: '1.6',
          metadata: {
            component: { type: 'library', ...expectedPackage },
          },
        },
        expectedPackage,
      ),
    ).not.toThrow()
    expect(() => assertCycloneDxBom([], expectedPackage)).toThrow('JSON object')
    expect(() =>
      assertCycloneDxBom({ bomFormat: 'SPDX' }, expectedPackage),
    ).toThrow('valid CycloneDX')
    expect(() =>
      assertCycloneDxBom(
        {
          bomFormat: 'CycloneDX',
          specVersion: '1.6',
          metadata: { component: { type: 'application' } },
        },
        expectedPackage,
      ),
    ).toThrow('does not match')
  })

  it('keeps generated release output inside the repository', () => {
    const repositoryRoot = path.resolve('repository-root')
    expect(
      resolveReleaseOutputPath(repositoryRoot, 'artifacts/sbom.json'),
    ).toBe(path.join(repositoryRoot, 'artifacts', 'sbom.json'))
    expect(() => resolveReleaseOutputPath(repositoryRoot, '.')).toThrow(
      'inside the repository',
    )
    expect(() => resolveReleaseOutputPath(repositoryRoot, '..')).toThrow(
      'inside the repository',
    )
  })

  it('binds publish validation to the expected workflow and master branch', async () => {
    const workflow = await fs.readFile('.github/workflows/publish.yaml', 'utf8')

    expect(workflow).toContain('actions/workflows/release-validation.yaml')
    expect(workflow).toContain('.workflow_id')
    expect(workflow).toContain('.head_branch')
    expect(workflow).toContain('master')
    expect(workflow).toContain('release_channel:')
    expect(workflow).toContain('RELEASE_CHANNEL:')
    expect(workflow).toContain('inputs.release_channel')
    expect(workflow).toContain('scripts/resolve-release-channel.ts')
    expect(workflow).toContain('release_dist_tag:')
    expect(workflow).toContain('steps.release_channel.outputs.dist_tag')
    expect(workflow).toContain(
      "needs.verify-and-pack.outputs.release_dist_tag == 'next'",
    )
    expect(workflow).not.toContain(
      "contains(needs.verify-and-pack.outputs.package_version, '-')",
    )
  })

  it('binds the release tag to the validated commit', async () => {
    const workflow = await fs.readFile('.github/workflows/publish.yaml', 'utf8')

    // Left unset, the create-release API tags the default branch's current tip,
    // which can move past the validated commit while the publish job waits for
    // its protected-environment approval.
    expect(workflow).toMatch(/target_commitish:\s*\$\{\{\s*github\.sha\s*\}\}/u)
    // An existing tag makes that target inert, so it must already match.
    expect(workflow).toContain('Require A Matching Release Tag')
    expect(workflow).toContain('git/ref/tags/$tag')
    expect(workflow).toContain('not the validated commit $GITHUB_SHA')
  })

  it('builds the release SBOM through npm with an explicit artifact path', async () => {
    const [workflow, packageJsonText] = await Promise.all([
      fs.readFile('.github/workflows/publish.yaml', 'utf8'),
      fs.readFile('package.json', 'utf8'),
    ])
    const packageJson = JSON.parse(packageJsonText) as {
      readonly scripts?: Readonly<Record<string, string>>
    }

    expect(packageJson.scripts?.sbom).toBe('tsx scripts/generate-sbom.ts')
    expect(workflow).toContain(
      'corepack npm run sbom -- release-artifacts/sbom.cdx.json',
    )
    expect(workflow).not.toContain(
      './node_modules/.bin/tsx scripts/generate-sbom.ts',
    )
  })

  it('publishes the packed artifact through an explicit local path', async () => {
    const [workflow, npmConfig] = await Promise.all([
      fs.readFile('.github/workflows/publish.yaml', 'utf8'),
      fs.readFile('.npmrc', 'utf8'),
    ])

    expect(workflow).toContain(
      'corepack npm publish ./release-artifacts/*.tgz --allow-file=all --access public --provenance --tag "$dist_tag"',
    )
    expect(workflow).not.toContain(
      'corepack npm publish release-artifacts/*.tgz',
    )
    expect(npmConfig).toContain('allow-file=root')
  })

  it('explicitly denies unused GeckoDriver install scripts', async () => {
    const packageJson = JSON.parse(
      await fs.readFile('package.json', 'utf8'),
    ) as {
      readonly allowScripts?: Readonly<Record<string, boolean>>
    }

    expect(packageJson.allowScripts?.geckodriver).toBe(false)
    expect(
      Object.keys(packageJson.allowScripts ?? {}).some((name) => {
        return name.startsWith('geckodriver@')
      }),
    ).toBe(false)
  })

  it('aligns Puppeteer support with the WebdriverIO v9 compatibility band', async () => {
    const [workflow, packageJsonText] = await Promise.all([
      fs.readFile('.github/workflows/release-validation.yaml', 'utf8'),
      fs.readFile('package.json', 'utf8'),
    ])
    const packageJson = JSON.parse(packageJsonText) as {
      readonly devDependencies?: Readonly<Record<string, string>>
      readonly peerDependencies?: Readonly<Record<string, string>>
      readonly peerDependenciesMeta?: Readonly<
        Record<string, { readonly optional?: boolean }>
      >
    }

    const peerPuppeteer = packageJson.peerDependencies?.['puppeteer-core'] ?? ''
    const developmentPuppeteer =
      packageJson.devDependencies?.['puppeteer-core'] ?? ''
    const developmentExpect =
      packageJson.devDependencies?.['expect-webdriverio'] ?? ''
    expect(peerPuppeteer).toBe('>=24.11.2 <25')
    expect(semver.intersects(developmentPuppeteer, peerPuppeteer)).toBe(true)
    expect(semver.satisfies('25.0.0', developmentPuppeteer)).toBe(false)
    expect(semver.satisfies('6.0.9', developmentExpect)).toBe(true)
    expect(semver.satisfies('7.0.0', developmentExpect)).toBe(false)
    expect(
      packageJson.peerDependenciesMeta?.['puppeteer-core']?.optional,
    ).not.toBe(true)
    expect(workflow).toContain('webdriverio@9.29.1 puppeteer-core@24.11.2')
    expect(workflow).toContain('expect-webdriverio@5.7.0')
    expect(workflow).toContain('@wdio/runner@9.29.1')
    expect(workflow).toContain('webdriverio@9 puppeteer-core@24')
    expect(workflow).toContain('@wdio/types@9 expect-webdriverio@6')
    expect(workflow).not.toContain('puppeteer-core@25')
  })
})
