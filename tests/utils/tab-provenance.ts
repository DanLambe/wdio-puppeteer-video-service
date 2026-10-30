import type {
  ManifestEntryV1,
  ManifestTab,
  ManifestTabReason,
} from '../../src/manifest.js'
import { orderSegments } from './segment-colors.js'

/** A tab's ordinal and why its segment started there. */
export type TabStep = readonly [number, ManifestTabReason]

const PART_FILE_RE = /_part\d+\./u

const isPartFile = (artifactPath: string): boolean =>
  PART_FILE_RE.test(artifactPath)

/**
 * The tabs a recorded entry's video names, in recording order: the final
 * file's, a merged file's, or each part file's.
 */
export const readEntryTabs = (
  entry: ManifestEntryV1,
): Array<ManifestTab | undefined> => {
  const { final, segments } = entry.capture
  if (final) {
    return final.tabs ?? []
  }
  const merged = segments.find((segment) => !isPartFile(segment.path))
  if (merged) {
    return merged.tabs ?? []
  }
  return orderSegments(segments).map((segment) => segment.tab)
}

export const toTabSteps = (
  tabs: ReadonlyArray<ManifestTab | undefined>,
): Array<TabStep | undefined> =>
  tabs.map((tab) => (tab ? [tab.ordinal, tab.reason] : undefined))

/**
 * Checks what holds for every new recording: each part file names its tab,
 * each merged or final file lists the tabs it holds, and ordinals and tab
 * identities match one to one. Returns the problems found.
 *
 * The first retained part need not be tab 1: an empty first part is
 * discarded. Tests that keep every part pin their exact sequence instead.
 */
export const findTabProvenanceProblems = (entry: ManifestEntryV1): string[] => {
  const { decision, final, segments } = entry.capture
  if (decision !== 'recorded') {
    return []
  }
  const name = entry.test?.name ?? entry.id
  const problems: string[] = []
  const listed: ManifestTab[] = []
  for (const segment of segments) {
    if (isPartFile(segment.path)) {
      if (segment.tab) {
        listed.push(segment.tab)
      } else {
        problems.push(`"${name}" has a part without its tab: ${segment.path}`)
      }
    } else if (segment.tabs?.length) {
      listed.push(...segment.tabs)
    } else {
      problems.push(`"${name}" has a merged file without its tabs`)
    }
  }
  if (final) {
    if (final.tabs?.length) {
      listed.push(...final.tabs)
    } else {
      problems.push(`"${name}" has a final file without its tabs`)
    }
  }
  if (!numbersTabsConsistently(listed)) {
    problems.push(`"${name}" numbers its tabs inconsistently`)
  }
  return problems
}

const numbersTabsConsistently = (tabs: readonly ManifestTab[]): boolean => {
  const ordinalByHash = new Map<string, number>()
  const hashByOrdinal = new Map<number, string>()
  for (const tab of tabs) {
    const knownOrdinal = ordinalByHash.get(tab.contextHash) ?? tab.ordinal
    const knownHash = hashByOrdinal.get(tab.ordinal) ?? tab.contextHash
    if (knownOrdinal !== tab.ordinal || knownHash !== tab.contextHash) {
      return false
    }
    ordinalByHash.set(tab.contextHash, tab.ordinal)
    hashByOrdinal.set(tab.ordinal, tab.contextHash)
  }
  return true
}
