import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ManifestFramework } from '../manifest.js'

export const normalizeManifestPath = (
  filePath: string,
  baseDir: string,
): string => {
  const resolvedBase = path.resolve(baseDir)
  const resolvedPath = path.resolve(
    filePath.startsWith('file:') ? fileURLToPath(filePath) : filePath,
  )
  const relative = path.relative(resolvedBase, resolvedPath)
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return sanitizePathComponent(path.basename(resolvedPath) || 'unknown')
  }
  return relative.split(path.sep).map(sanitizePathComponent).join('/')
}

export const hashPrivateValue = (salt: string, value: string): string => {
  return createHash('sha256')
    .update(salt)
    .update('\0')
    .update(value)
    .digest('hex')
}

export const normalizeManifestFramework = (
  value: unknown,
): ManifestFramework => {
  return value === 'mocha' || value === 'jasmine' || value === 'cucumber'
    ? value
    : 'unknown'
}

const sanitizePathComponent = (value: string): string => {
  let sanitized = ''
  for (const character of value) {
    sanitized += (character.codePointAt(0) ?? 0) <= 31 ? '_' : character
  }
  return sanitized || 'unknown'
}
