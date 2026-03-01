# Release Notes Format

Use commit messages in this structure to produce clean release notes:

```text
Version X.X.X
- feature or change here
- improvement here
- bumped deps
```

The publish workflow uses `scripts/generate-release-notes.ts` to:

- Prefer `- ...` lines from commit messages
- Fall back to commit subject lines when bullets are not present
- Emit a final release body in this format:

```text
Version X.X.X
- item 1
- item 2
```

If you squash-merge into `master`, put the `Version X.X.X` header and bullets in the squash commit message body to get the cleanest release notes.

Preview locally with:

```bash
npm run release:notes
```
