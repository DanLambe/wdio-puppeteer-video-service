import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

type Execute = (command: string, args: string[]) => string

export const resolveBaseline = (
  execute: Execute,
  reference: string,
): string => {
  const sha = execute('git', [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${reference}^{commit}`,
  ])
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha)) {
    throw new Error('Git did not return a single commit object ID')
  }
  return sha
}

export const resolveImage = (execute: Execute, reference: string): string => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/u.test(reference)) {
    throw new Error('Expected a Docker image name, tag or digest')
  }
  const id = execute('docker', [
    'inspect',
    '--type=image',
    '--format',
    '{{.Id}}',
    '--',
    reference,
  ])
  if (!/^sha256:[a-f0-9]{64}$/u.test(id)) {
    throw new Error('Docker did not return a single immutable image ID')
  }
  return id
}

/**
 * Creates an output or resume directory, which must lie inside `base`, and
 * returns its canonical path. The run writes, reads and mounts only inside it,
 * so a mistyped or injected path is rejected before anything is created, and
 * so is a path through a link that leads out of `base`.
 */
export const prepareOutputDirectory = async (
  base: string,
  requested: string,
): Promise<string> => {
  const outside = () =>
    new Error(`Benchmark output must be a directory inside ${base}`)
  // Relative paths resolve from the working directory, as they always have.
  const relative = path.relative(base, path.resolve(requested))
  const candidate = path.join(base, relative)
  if (
    path.isAbsolute(relative) ||
    !candidate.startsWith(`${base}${path.sep}`)
  ) {
    throw outside()
  }
  await fs.mkdir(base, { recursive: true })
  const canonicalBase = await fs.realpath(base)
  const inside = (target: string) =>
    target.startsWith(`${canonicalBase}${path.sep}`)
  // Resolve the deepest existing ancestor before creating anything below it.
  let existing = path.dirname(candidate)
  while (existing !== base && !existsSync(existing)) {
    existing = path.dirname(existing)
  }
  if (existing !== base && !inside(await fs.realpath(existing))) {
    throw outside()
  }
  await fs.mkdir(candidate, { recursive: true })
  const directory = await fs.realpath(candidate)
  if (!inside(directory)) {
    throw outside()
  }
  return directory
}
