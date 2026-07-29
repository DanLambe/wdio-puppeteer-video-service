import { describe, expect, it } from 'vitest'
import {
  extractChangelogSection,
  generateReleaseNotes,
} from '../../scripts/generate-release-notes.js'

describe('release-note generation', () => {
  const changelog = `# Changelog

## 2.0.0

- New major behavior.

  Continuation details stay with the entry.

## [1.5.0]

- Previous behavior.
`

  it('extracts the exact version section without the next heading', () => {
    expect(extractChangelogSection(changelog, '2.0.0')).toBe(
      '- New major behavior.\n\n  Continuation details stay with the entry.',
    )
    expect(extractChangelogSection(changelog, '1.5.0')).toBe(
      '- Previous behavior.',
    )
  })

  it('returns undefined when the version is not documented', () => {
    expect(extractChangelogSection(changelog, '3.0.0')).toBeUndefined()
  })

  it('prefers curated changelog content over commit-derived notes', () => {
    expect(generateReleaseNotes('2.0.0', 'invalid-range', changelog)).toBe(
      'Version 2.0.0\n- New major behavior.\n\n  Continuation details stay with the entry.',
    )
  })
})
