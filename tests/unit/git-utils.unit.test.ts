import { afterEach, describe, expect, it, vi } from 'vitest'

const originalGitPath = process.env.GIT_PATH

const loadGitUtils = async (options?: {
  gitPath?: string
  executablePaths?: string[]
  executableCommands?: string[]
}) => {
  vi.resetModules()
  vi.restoreAllMocks()

  if (options?.gitPath === undefined) {
    delete process.env.GIT_PATH
  } else {
    process.env.GIT_PATH = options.gitPath
  }

  const executablePaths = new Set(options?.executablePaths ?? [])
  const executableCommands = new Set(options?.executableCommands ?? [])
  const accessSync = vi.fn((filePath: string) => {
    if (!executablePaths.has(filePath)) {
      throw new Error(`missing executable: ${filePath}`)
    }
  })
  const spawnSync = vi.fn((command: string) => {
    if (executableCommands.has(command)) {
      return {
        status: 0,
      }
    }

    return {
      status: 1,
      error: new Error(`failed command: ${command}`),
    }
  })

  vi.doMock('node:fs', () => ({
    accessSync,
    constants: {
      F_OK: 0,
      X_OK: 1,
    },
  }))
  vi.doMock('node:child_process', () => ({
    execFileSync: vi.fn(),
    spawnSync,
  }))

  const module = await import('../../scripts/git-utils.js')
  return {
    ...module,
    accessSync,
    spawnSync,
  }
}

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  vi.doUnmock('node:fs')
  vi.doUnmock('node:child_process')

  if (originalGitPath === undefined) {
    delete process.env.GIT_PATH
    return
  }

  process.env.GIT_PATH = originalGitPath
})

describe('git-utils resolveGitBinaryPath', () => {
  it('returns the configured absolute GIT_PATH when it is executable', async () => {
    const configuredGitPath =
      process.platform === 'win32'
        ? String.raw`C:\custom\git.exe`
        : '/custom/git'
    const { resolveGitBinaryPath } = await loadGitUtils({
      gitPath: configuredGitPath,
      executablePaths: [configuredGitPath],
    })

    expect(resolveGitBinaryPath()).toBe(configuredGitPath)
  })

  it('returns a usable git binary when no explicit GIT_PATH is configured', async () => {
    const { resolveGitBinaryPath } = await loadGitUtils({
      executableCommands: ['git'],
    })

    expect(resolveGitBinaryPath()).toMatch(/git(?:\.exe)?$/i)
  })
})
