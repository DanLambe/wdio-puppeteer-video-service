import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertPackageMetadata,
  parsePackResult,
} from '../../scripts/check-packed-consumer.js'
import {
  assertCycloneDxBom,
  resolveReleaseOutputPath,
} from '../../scripts/generate-sbom.js'

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
  })
})
