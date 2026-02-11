import { pathToFileURL } from 'node:url'
import { runGit } from './git-utils.js'

export const generateReleaseNotes = (
  version: string,
  range: string = 'HEAD',
): string => {
  const commitMessages = readCommits(range)
  const bullets = extractBullets(commitMessages)
  return [`Version ${version}`, ...bullets].join('\n')
}

export const readCommits = (commitRange: string): string[] => {
  const output = runGit(['log', commitRange, '--format=%B%x00'])

  return output
    .split('\u0000')
    .map((message) => message.trim())
    .filter((message) => message.length > 0)
}

export const normalizeBullet = (line: string): string => {
  const trimmedLine = line.trim()
  return trimmedLine.startsWith('- ')
    ? trimmedLine
    : `- ${trimmedLine.replace(/^-\s*/, '')}`
}

const VERSION_HEADER_PATTERN = /^version\s+\d+\.\d+\.\d+$/i
const MERGE_PR_HEADER_PATTERN = /^merge pull request\b/i
const MERGE_BRANCH_HEADER_PATTERN = /^merge branch\b/i

const parseMessageLines = (message: string): string[] => {
  return message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

const isVersionHeader = (header: string): boolean => {
  return VERSION_HEADER_PATTERN.test(header)
}

const isMergeHeader = (header: string): boolean => {
  return (
    MERGE_PR_HEADER_PATTERN.test(header) ||
    MERGE_BRANCH_HEADER_PATTERN.test(header)
  )
}

const parseMessage = (
  message: string,
): { header?: string; lines: string[]; hasLines: boolean } => {
  const lines = parseMessageLines(message)
  return {
    header: lines[0],
    lines,
    hasLines: lines.length > 0,
  }
}

const toBodyBullets = (lines: string[], skipHeader: boolean): string[] => {
  return lines
    .slice(skipHeader ? 1 : 0)
    .filter((line) => line.startsWith('- '))
    .map(normalizeBullet)
}

const findVersionCommitBullets = (
  commitMessages: string[],
): string[] | undefined => {
  for (const message of commitMessages) {
    const { header, lines, hasLines } = parseMessage(message)
    if (!hasLines || !header || !isVersionHeader(header)) {
      continue
    }

    const versionBullets = toBodyBullets(lines, true)
    if (versionBullets.length > 0) {
      return [...new Set(versionBullets)]
    }
  }

  return undefined
}

const addUniqueBullets = (
  target: string[],
  seen: Set<string>,
  nextBullets: string[],
): void => {
  for (const bullet of nextBullets) {
    if (!seen.has(bullet)) {
      seen.add(bullet)
      target.push(bullet)
    }
  }
}

const collectFallbackBullets = (commitMessages: string[]): string[] => {
  const bullets: string[] = []
  const seen = new Set<string>()

  for (const message of commitMessages) {
    const { header, lines, hasLines } = parseMessage(message)
    if (!hasLines || !header || isMergeHeader(header)) {
      continue
    }

    const bodyBullets = toBodyBullets(lines, isVersionHeader(header))

    if (bodyBullets.length > 0) {
      addUniqueBullets(bullets, seen, bodyBullets)
      continue
    }

    const fallbackBullet = normalizeBullet(header)
    addUniqueBullets(bullets, seen, [fallbackBullet])
  }

  return bullets
}

export const extractBullets = (commitMessages: string[]): string[] => {
  const versionBullets = findVersionCommitBullets(commitMessages)
  if (versionBullets && versionBullets.length > 0) {
    return versionBullets
  }

  const fallbackBullets = collectFallbackBullets(commitMessages)
  if (fallbackBullets.length > 0) {
    return fallbackBullets
  }

  return ['- Maintenance release']
}

const runCli = (): void => {
  const version = process.argv[2]?.trim()
  const range = process.argv[3]?.trim() || 'HEAD'

  if (!version) {
    console.error(
      'Usage: tsx scripts/generate-release-notes.ts <version> [git-range]',
    )
    process.exit(1)
  }

  console.log(generateReleaseNotes(version, range))
}

const isExecutedDirectly = (() => {
  const argvPath = process.argv[1]
  if (!argvPath) {
    return false
  }
  return import.meta.url === pathToFileURL(argvPath).href
})()

if (isExecutedDirectly) {
  runCli()
}
