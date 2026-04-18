import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertVersionBump,
  readVersion,
  runCli,
} from '../../scripts/check-version-bump.js'

const originalArgv = [...process.argv]

afterEach(() => {
  process.argv = [...originalArgv]
  vi.resetModules()
  vi.restoreAllMocks()
  vi.doUnmock('node:fs')
  vi.doUnmock('../../scripts/git-utils.js')
})

describe('check-version-bump helpers', () => {
  it('reads a valid semver version from package.json contents', () => {
    expect(readVersion('{ "version": "1.2.3" }', 'package.json')).toBe('1.2.3')
  })

  it('rejects missing or invalid versions', () => {
    expect(() => readVersion('{ "name": "pkg" }', 'package.json')).toThrow(
      'Unable to determine package version',
    )
    expect(() => readVersion('{ "version": "next" }', 'package.json')).toThrow(
      'Invalid semver version',
    )
  })

  it('accepts only strictly increasing version bumps', () => {
    expect(() => assertVersionBump('1.2.4', '1.2.3')).not.toThrow()
    expect(() => assertVersionBump('1.2.3', '1.2.3')).toThrow(
      'package.json version must be greater than the base version',
    )
  })

  it('runCli validates the current version against the base ref and logs success', async () => {
    process.argv = [
      process.execPath,
      path.resolve('tests/unit/check-version-bump.unit.test.ts'),
      'origin/main',
    ]

    const logSpy = vi.fn()

    runCli({
      log: logSpy,
      readPackageJson: () => '{ "version": "1.2.4" }',
      runGitCommand: () => '{ "version": "1.2.3" }',
    })

    expect(logSpy).toHaveBeenCalledWith(
      'Version bump check passed: 1.2.3 -> 1.2.4',
    )
  })

  it('runCli requires a base ref argument', () => {
    process.argv = [
      process.execPath,
      path.resolve('tests/unit/check-version-bump.unit.test.ts'),
    ]

    expect(() => runCli()).toThrow(
      'Usage: tsx scripts/check-version-bump.ts <base-git-ref>',
    )
  })
})
