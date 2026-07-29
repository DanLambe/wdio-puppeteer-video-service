# Release Notes Format

Consumer-facing release notes come from the matching version section in
`CHANGELOG.md`, which Changesets maintains. For example:

```text
## X.X.X
- feature or change here
- improvement here
```

The publish workflow uses `scripts/generate-release-notes.ts` to:

- Prefer the exact `CHANGELOG.md` section for the package version
- Fall back to curated commit bullets and then commit subjects only when the
  changelog has no matching section
- Emit a final release body headed by `Version X.X.X`

```text
Version X.X.X
- item 1
- item 2
```

Keep internal refactor details out of the changelog unless they affect package
consumers. Conventional commit subjects remain useful as a fallback, but are
not the primary release-note source.

Preview locally with:

```bash
npm run release:notes
```
