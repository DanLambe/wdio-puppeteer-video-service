import type { ManifestEntryV1 } from '../manifest.js'
import type { ReporterTestOutcome } from './types.js'

export type ManifestMatch =
  | { readonly kind: 'matched'; readonly entry: ManifestEntryV1 }
  | { readonly kind: 'missing' | 'ambiguous' }

export interface OutcomeMatch {
  readonly outcome: ReporterTestOutcome
  readonly match: ManifestMatch
}

// Each pass runs over every outcome before the next begins, so a looser pass
// can never take a capture that a stricter one would give another outcome.
const PASSES = ['exact', 'normalized', 'fallback'] as const
type Pass = (typeof PASSES)[number]

interface TestIdentity {
  readonly name: string
  readonly fullName?: string
}

interface EntryQueue {
  readonly entries: ManifestEntryV1[]
  next: number
}

/**
 * The exact names captures were recorded with, by normalized form. A reported
 * name means its own spelling whenever a capture used it, and another spelling
 * only when that is the one spelling normalizing the same way. Distinct
 * spellings are distinct tests: which of them is still unclaimed is never a
 * reason to pick one.
 */
class Spellings {
  private readonly byNormalized = new Map<string, Set<string>>()

  add(name: string): void {
    const key = normalizeIdentity(name)
    const names = this.byNormalized.get(key) ?? new Set()
    this.byNormalized.set(key, names.add(name))
  }

  of(name: string): readonly string[] {
    const names = this.byNormalized.get(normalizeIdentity(name))
    if (!names) {
      return []
    }
    return names.has(name) ? [name] : [...names]
  }
}

/** Unclaimed captures by each exact name they were recorded with. */
class AliasIndex {
  private readonly entries = new Map<string, Set<ManifestEntryV1>>()
  private readonly spellings = new Spellings()

  add(name: string, entry: ManifestEntryV1): void {
    const entries = this.entries.get(name) ?? new Set()
    this.entries.set(name, entries.add(entry))
    this.spellings.add(name)
  }

  claim(entry: ManifestEntryV1): void {
    for (const name of identityNames(entry)) {
      this.entries.get(name)?.delete(entry)
    }
  }

  find(name: string): ReadonlySet<ManifestEntryV1> | 'ambiguous' {
    const [spelling, ...others] = this.spellings.of(name)
    if (others.length > 0) {
      return 'ambiguous'
    }
    return (
      (spelling === undefined ? undefined : this.entries.get(spelling)) ??
      new Set()
    )
  }
}

interface EntryGroup {
  /** Captures by their exact full name, in recording order. */
  readonly fullNames: Map<string, EntryQueue>
  readonly fullNameSpellings: Spellings
  readonly aliases: AliasIndex
  readonly withoutFullerIdentity: AliasIndex
  spec?: ManifestEntryV1
}

export class ManifestMatcher {
  readonly matchedEntries: Set<string> = new Set()
  private readonly groups = new Map<string, EntryGroup>()
  /** Group keys by their form with the spec path's case ignored. */
  private readonly groupSpellings = new Map<string, string[]>()
  private readonly scenarios = new Map<string, ManifestEntryV1>()

  constructor(entries: readonly ManifestEntryV1[]) {
    for (const entry of entries) {
      const key = groupKey(entry)
      let group = this.groups.get(key)
      if (!group) {
        group = {
          fullNames: new Map(),
          fullNameSpellings: new Spellings(),
          aliases: new AliasIndex(),
          withoutFullerIdentity: new AliasIndex(),
        }
        this.groups.set(key, group)
        const caseless = caselessGroupKey(entry)
        this.groupSpellings.set(caseless, [
          ...(this.groupSpellings.get(caseless) ?? []),
          key,
        ])
      }
      if (entry.scope === 'spec') {
        group.spec ??= entry
      } else if (entry.test) {
        const fullName = entry.test.fullName
        if (fullName) {
          let queue = group.fullNames.get(fullName)
          if (!queue) {
            queue = { entries: [], next: 0 }
            group.fullNames.set(fullName, queue)
          }
          queue.entries.push(entry)
          group.fullNameSpellings.add(fullName)
        }
        // Cucumber scenarios are recorded with their title as both names, so
        // their full name adds nothing a reporter's longer title can confirm.
        if (!hasFullerIdentity(entry.test)) {
          group.withoutFullerIdentity.add(entry.test.name, entry)
        }
        for (const name of identityNames(entry)) {
          group.aliases.add(name, entry)
        }
      }
    }
  }

  /**
   * Full identities claim their captures before any short-title fallback runs,
   * so a fallback can never take a capture that another outcome identifies
   * exactly, whatever order the outcomes arrive in. Exact full names come
   * first; a name that differs only in case, spacing or Unicode form matches
   * only when no other capture's name normalizes the same way. An outcome
   * whose own spelling's captures are all claimed matches none of another
   * spelling's.
   */
  matchAll(outcomes: readonly ReporterTestOutcome[]): OutcomeMatch[] {
    let matches: OutcomeMatch[] = outcomes.map((outcome) => ({
      outcome,
      match: { kind: 'missing' },
    }))
    for (const pass of PASSES) {
      matches = matches.map(({ outcome, match }) => ({
        outcome,
        // An ambiguous identity stays ambiguous rather than fall further.
        match: match.kind === 'missing' ? this.match(outcome, pass) : match,
      }))
    }
    return matches
  }

  private match(outcome: ReporterTestOutcome, pass: Pass): ManifestMatch {
    const key = groupKey(outcome)
    const group = this.findGroup(outcome)
    if (group === 'ambiguous') {
      return { kind: 'ambiguous' }
    }
    if (!group) {
      return { kind: 'missing' }
    }
    const container = outcome.test.containerName
    // A scenario's parent id is stable across its steps and distinct for
    // same-titled scenarios and expanded outline rows.
    const scenarioKey = JSON.stringify([
      key,
      outcome.test.parent ?? '',
      container ?? '',
    ])
    const assigned = container ? this.scenarios.get(scenarioKey) : undefined
    if (assigned) {
      return { kind: 'matched', entry: assigned }
    }
    const identity = container
      ? { name: container, fullName: container }
      : outcome.test
    const result =
      pass === 'fallback'
        ? this.findFallback(group, identity)
        : this.findFullName(group, identity, pass)
    if (result.kind === 'matched') {
      this.claim(group, result.entry)
      if (container) {
        this.scenarios.set(scenarioKey, result.entry)
      }
      return result
    }
    if (pass === 'fallback' && result.kind === 'missing' && group.spec) {
      this.matchedEntries.add(group.spec.id)
      return { kind: 'matched', entry: group.spec }
    }
    return result
  }

  /**
   * Spec paths that differ only in case can be different files, so an
   * outcome's own spelling wins. Another spelling is used only when it is the
   * one recorded, and several are no basis for choosing.
   */
  private findGroup(
    outcome: ReporterTestOutcome,
  ): EntryGroup | 'ambiguous' | undefined {
    const exact = this.groups.get(groupKey(outcome))
    if (exact) {
      return exact
    }
    const [spelling, ...others] =
      this.groupSpellings.get(caselessGroupKey(outcome)) ?? []
    if (others.length > 0) {
      return 'ambiguous'
    }
    return spelling === undefined ? undefined : this.groups.get(spelling)
  }

  private findFullName(
    group: EntryGroup,
    identity: TestIdentity,
    pass: Exclude<Pass, 'fallback'>,
  ): ManifestMatch {
    if (!identity.fullName) {
      return { kind: 'missing' }
    }
    let fullName = identity.fullName
    if (pass === 'normalized') {
      const [spelling, ...others] = group.fullNameSpellings.of(fullName)
      // The exact pass already tried the outcome's own full name.
      if (spelling === undefined || spelling === fullName) {
        return { kind: 'missing' }
      }
      if (others.length > 0) {
        return { kind: 'ambiguous' }
      }
      fullName = spelling
    }
    const queue = group.fullNames.get(fullName)
    while (queue && queue.next < queue.entries.length) {
      const entry = queue.entries[queue.next++]
      if (entry && !this.matchedEntries.has(entry.id)) {
        return { kind: 'matched', entry }
      }
    }
    return { kind: 'missing' }
  }

  private findFallback(
    group: EntryGroup,
    identity: TestIdentity,
  ): ManifestMatch {
    // When both sides have fuller identities, a shared short title is not
    // evidence that they describe the same test.
    const aliases = hasFullerIdentity(identity)
      ? group.withoutFullerIdentity
      : group.aliases
    let candidate: ManifestEntryV1 | undefined
    for (const name of [identity.name, identity.fullName]) {
      if (!name) {
        continue
      }
      const matches = aliases.find(name)
      if (matches === 'ambiguous' || matches.size > 1) {
        return { kind: 'ambiguous' }
      }
      if (matches.size === 0) {
        continue
      }
      const entry = matches.values().next().value
      if (candidate && candidate !== entry) {
        return { kind: 'ambiguous' }
      }
      candidate = entry
    }
    return candidate
      ? { kind: 'matched', entry: candidate }
      : { kind: 'missing' }
  }

  private claim(group: EntryGroup, entry: ManifestEntryV1): void {
    this.matchedEntries.add(entry.id)
    group.aliases.claim(entry)
    group.withoutFullerIdentity.claim(entry)
  }
}

const hasFullerIdentity = (identity: TestIdentity): boolean => {
  return (
    !!identity.fullName &&
    normalizeIdentity(identity.fullName) !== normalizeIdentity(identity.name)
  )
}

const identityNames = (entry: ManifestEntryV1): string[] => {
  return [entry.test?.name, entry.test?.fullName].filter(
    (name): name is string => !!name,
  )
}

type GroupIdentity = Pick<ManifestEntryV1, 'runId' | 'cid' | 'spec' | 'attempt'>

const specPath = (spec: string): string => {
  return spec.replaceAll('\\', '/').replace(/^\.\//u, '')
}

const groupKey = (entry: GroupIdentity): string => {
  return JSON.stringify([
    entry.runId,
    entry.cid,
    specPath(entry.spec),
    entry.attempt,
  ])
}

const caselessGroupKey = (entry: GroupIdentity): string => {
  return JSON.stringify([
    entry.runId,
    entry.cid,
    specPath(entry.spec).toLowerCase(),
    entry.attempt,
  ])
}

const normalizeIdentity = (value: string): string => {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
}
