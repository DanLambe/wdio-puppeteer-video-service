# Changesets

User-visible changes require a changeset created with `npm run changeset`.
Select the appropriate semantic version impact and describe the behavior from a
consumer's perspective. The release workflow collects these files into a
version/changelog pull request; ordinary pull requests do not edit the package
version directly.

Use `npm run version-packages` for version preparation. It runs Changesets and
synchronizes both root version fields in `package-lock.json` without resolving
or updating dependencies. `npm run check:release-version` is read-only and
rejects mismatches; PR checks run it before dependency installation, and package
and release checks enforce it again before artifacts are built.

Documentation-only, test-only, and internal CI changes may use an empty
changeset when the pull-request check requires an explicit release decision.
