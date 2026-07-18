# Changesets

User-visible changes require a changeset created with `npm run changeset`.
Select the appropriate semantic version impact and describe the behavior from a
consumer's perspective. The release workflow collects these files into a
version/changelog pull request; ordinary pull requests do not edit the package
version directly.

Documentation-only, test-only, and internal CI changes may use an empty
changeset when the pull-request check requires an explicit release decision.
