import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  prepareOutputDirectory,
  resolveBaseline,
} from '../../scripts/bench/pipeline/inputs.js'
import { hashTree } from '../../scripts/bench/pipeline/snapshot.js'

it('resolves a real Git commit and rejects option-like references', () => {
  const execute = (command: string, args: string[]) =>
    execFileSync(command, args, {
      cwd: path.resolve(import.meta.dirname, '../..'),
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  expect(resolveBaseline(execute, 'HEAD')).toBe(
    execute('git', ['rev-parse', 'HEAD']),
  )
  expect(() => resolveBaseline(execute, '--help')).toThrow()
})

it('preserves saved snapshot hashes with UTF-16 path ordering', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-hash-'))
  try {
    // This explicit order differs from locale-aware sorting and keeps a nested path.
    const files = [
      'Z.ts',
      'a.ts',
      'nested/z.ts',
      '\u00e9.ts',
      '\u0394.ts',
      '\ud83d\ude00.ts',
    ]
    await fs.mkdir(path.join(directory, 'nested'))
    await fs.mkdir(path.join(directory, 'empty'))
    for (const file of [...files].reverse()) {
      await fs.writeFile(path.join(directory, file), `content:${file}`)
    }
    const legacyHash = createHash('sha256')
    for (const file of files) {
      legacyHash.update(file)
      legacyHash.update(`content:${file}`)
    }
    expect(await hashTree(directory)).toBe(legacyHash.digest('hex'))
    const previous = await hashTree(directory)
    await fs.writeFile(path.join(directory, 'a.ts'), 'changed')
    expect(await hashTree(directory)).not.toBe(previous)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

describe('benchmark output directory', () => {
  const repository = path.resolve(import.meta.dirname, '../..')
  const outsideMessage = 'must be a directory inside'
  let fixture: string
  let base: string

  beforeEach(async () => {
    // Inside the repository, so a relative path from the working directory exists.
    const parent = path.join(repository, 'tests', 'results')
    await fs.mkdir(parent, { recursive: true })
    fixture = await fs.mkdtemp(path.join(parent, 'pipeline-host-'))
    base = path.join(fixture, 'pipeline')
  })

  afterEach(async () => {
    await fs.rm(fixture, { recursive: true, force: true })
  })

  it('creates a nested directory and returns its canonical path', async () => {
    const directory = await prepareOutputDirectory(
      base,
      path.join(base, 'qualification', 'run'),
    )
    expect(directory).toBe(
      path.join(await fs.realpath(base), 'qualification', 'run'),
    )
    expect((await fs.stat(directory)).isDirectory()).toBe(true)
  })

  it('resolves a relative path from the working directory and reuses it', async () => {
    const requested = path.relative(
      process.cwd(),
      path.join(base, 'qualification'),
    )
    expect(path.isAbsolute(requested)).toBe(false)
    const directory = await prepareOutputDirectory(base, requested)
    await fs.writeFile(path.join(directory, 'environment.json'), '{}')
    expect(await prepareOutputDirectory(base, requested)).toBe(directory)
    expect(
      await fs.readFile(path.join(directory, 'environment.json'), 'utf8'),
    ).toBe('{}')
  })

  it.each([
    ['the results root itself', (root: string) => root],
    ['its parent', (root: string) => path.dirname(root)],
    [
      'a sibling that shares its name as a prefix',
      (root: string) => `${root}-other`,
    ],
    [
      'a path that climbs out',
      (root: string) => [root, 'run', '..', '..', 'escape'].join(path.sep),
    ],
    [
      'an unrelated absolute path',
      (root: string) =>
        path.join(os.tmpdir(), `${path.basename(path.dirname(root))}-escape`),
    ],
  ])('rejects %s before creating anything', async (_, requested) => {
    const target = requested(base)
    await expect(prepareOutputDirectory(base, target)).rejects.toThrow(
      outsideMessage,
    )
    expect(await fs.readdir(fixture)).toEqual([])
    expect(existsSync(target)).toBe(target === path.dirname(base))
  })

  it.runIf(process.platform === 'win32')(
    'rejects a path on another drive',
    async () => {
      const drive = base.startsWith('Z:') ? 'Y:' : 'Z:'
      await expect(
        prepareOutputDirectory(base, [drive, 'pipeline', 'run'].join(path.sep)),
      ).rejects.toThrow(outsideMessage)
      expect(await fs.readdir(fixture)).toEqual([])
    },
  )

  it('rejects a link that leads out and creates nothing through it', async () => {
    const outside = path.join(fixture, 'outside')
    await fs.mkdir(outside)
    await fs.mkdir(base)
    await fs.symlink(outside, path.join(base, 'link'), 'junction')
    for (const requested of [
      path.join(base, 'link'),
      path.join(base, 'link', 'run'),
      path.join(base, 'link', 'nested', 'run'),
    ]) {
      await expect(prepareOutputDirectory(base, requested)).rejects.toThrow(
        outsideMessage,
      )
    }
    expect(await fs.readdir(outside)).toEqual([])
  })

  it('accepts a link that stays inside the results root', async () => {
    const target = path.join(base, 'runs')
    await fs.mkdir(target, { recursive: true })
    await fs.symlink(target, path.join(base, 'latest'), 'junction')
    expect(
      await prepareOutputDirectory(base, path.join(base, 'latest', 'run')),
    ).toBe(path.join(await fs.realpath(target), 'run'))
  })
})
