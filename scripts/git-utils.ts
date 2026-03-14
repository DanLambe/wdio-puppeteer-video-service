import { execFileSync, spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import path from 'node:path'

const COMMON_GIT_PATHS: string[] = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  String.raw`C:\Program Files\Git\cmd\git.exe`,
  String.raw`C:\Program Files\Git\bin\git.exe`,
  String.raw`C:\Program Files (x86)\Git\cmd\git.exe`,
  String.raw`C:\Program Files (x86)\Git\bin\git.exe`,
]

const resolveGitPathFromProgramFiles = (): string[] => {
  const candidates: string[] = []
  const programFilesRoots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LocalAppData,
  ]

  for (const root of programFilesRoots) {
    if (!root) {
      continue
    }

    candidates.push(
      path.join(root, 'Git', 'cmd', 'git.exe'),
      path.join(root, 'Git', 'bin', 'git.exe'),
    )
  }

  return candidates
}

const isExecutableFile = (filePath: string): boolean => {
  try {
    const mode =
      process.platform === 'win32'
        ? constants.F_OK
        : constants.F_OK | constants.X_OK
    accessSync(filePath, mode)
    return true
  } catch {
    return false
  }
}

const canExecuteBinary = (command: string): boolean => {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    stdio: 'ignore',
    windowsHide: true,
  })

  return !result.error && result.status === 0
}

export const resolveGitBinaryPath = (): string => {
  const configuredGitPath = process.env.GIT_PATH?.trim()
  if (configuredGitPath) {
    if (!path.isAbsolute(configuredGitPath)) {
      throw new Error(
        `GIT_PATH must be an absolute path. Received: ${configuredGitPath}`,
      )
    }

    if (!isExecutableFile(configuredGitPath)) {
      throw new Error(
        `GIT_PATH does not point to an executable file: ${configuredGitPath}`,
      )
    }

    return configuredGitPath
  }

  const candidates = [...COMMON_GIT_PATHS, ...resolveGitPathFromProgramFiles()]
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) {
      return candidate
    }
  }

  if (canExecuteBinary('git')) {
    return 'git'
  }

  throw new Error(
    'Unable to locate git binary in known locations. Set GIT_PATH to an absolute git executable path.',
  )
}

export const runGit = (args: string[], cwd?: string): string => {
  const gitPath = resolveGitBinaryPath()
  return execFileSync(gitPath, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}
