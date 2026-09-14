import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export interface PendingInstallScript {
  /** The package name, as npm derives it from the registry tarball URL. */
  readonly name: string
  /** The installed `name@version` that npm would refuse to run scripts for. */
  readonly key: string
}

interface PendingSummaryEntry {
  readonly name?: unknown
  readonly changes?: unknown
}

/**
 * Reads `npm approve-scripts --allow-scripts-pending --json`. npm applies the
 * project's `allowScripts` policy to the installed tree itself, so this never
 * re-implements its matching rules; it only turns the listing into a failure.
 */
export const parsePendingInstallScripts = (
  output: string,
): PendingInstallScript[] => {
  const parsed: unknown = JSON.parse(output)
  const entries =
    typeof parsed === 'object' && parsed !== null
      ? Reflect.get(parsed, 'allowScripts')
      : undefined
  if (!Array.isArray(entries)) {
    throw new TypeError(
      'npm approve-scripts did not return an allowScripts list',
    )
  }
  return entries.flatMap((entry: PendingSummaryEntry) => {
    if (typeof entry.name !== 'string' || !Array.isArray(entry.changes)) {
      throw new TypeError('npm approve-scripts returned a malformed entry')
    }
    const name = entry.name
    return entry.changes.flatMap((change: unknown) => {
      const key =
        typeof change === 'object' && change !== null
          ? Reflect.get(change, 'key')
          : undefined
      const state =
        typeof change === 'object' && change !== null
          ? Reflect.get(change, 'change')
          : undefined
      return state === 'pending' && typeof key === 'string'
        ? [{ name, key }]
        : []
    })
  })
}

export const describePendingInstallScripts = (
  pending: readonly PendingInstallScript[],
): string => {
  const names = [...new Set(pending.map(({ name }) => name))]
  return [
    `${pending.length.toString()} installed package${pending.length === 1 ? ' has' : 's have'} install scripts that package.json allowScripts does not cover:`,
    ...pending.map(({ key }) => `  - ${key}`),
    '',
    'Review each script before deciding. Deny a script the project does not need',
    'with a name-only entry, which covers future versions:',
    ...names.map((name) => `  "${name}": false`),
    'Approve a required script only for the exact reviewed version:',
    ...pending.map(({ key }) => `  "${key}": true`),
  ].join('\n')
}

const runNpm = (args: readonly string[]): string => {
  const npmCli = process.env.npm_execpath
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { encoding: 'utf8' })
    : spawnSync('npm', args, {
        encoding: 'utf8',
        shell: process.platform === 'win32',
      })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(
      `npm ${args.join(' ')} failed with exit code ${String(result.status)}: ${result.stderr.trim()}`,
    )
  }
  return result.stdout
}

const isExecutedDirectly = (() => {
  const argvPath = process.argv[1]
  return argvPath ? import.meta.url === pathToFileURL(argvPath).href : false
})()

if (isExecutedDirectly) {
  const pending = parsePendingInstallScripts(
    runNpm(['approve-scripts', '--allow-scripts-pending', '--json']),
  )
  if (pending.length === 0) {
    process.stdout.write(
      'Every installed package with install scripts is covered by allowScripts.\n',
    )
  } else {
    process.stderr.write(`${describePendingInstallScripts(pending)}\n\n`)
    // npm's own listing shows the script commands under review.
    process.stderr.write(runNpm(['approve-scripts', '--allow-scripts-pending']))
    process.exitCode = 1
  }
}
