# Releasing

Releases are prepared by Changesets and published manually from a tested npm
tarball. A merge to `master` never publishes to npm by itself.

## One-time npm setup

Configure an npm trusted publisher for:

- GitHub owner: `DanLambe`
- Repository: `wdio-puppeteer-video-service`
- Workflow filename: `publish.yaml`
- GitHub environment: `npm`

Create the matching protected `npm` environment in GitHub if approval is
required. The publish job grants only `contents: read` and `id-token: write`;
it does not use a long-lived npm token. Keep the repository URL in
`package.json` synchronized with the trusted-publisher configuration.

For the Changesets release-PR workflow, enable **Settings → Actions → General →
Workflow permissions → Allow GitHub Actions to create and approve pull
requests**. The workflow uses the repository `GITHUB_TOKEN`; it does not need a
separate personal access token.

## Prepare a release

1. Add a consumer-facing changeset with `npm run changeset` for each relevant
   pull request. Internal-only work may use an empty changeset.
2. Merge changes to `master`. The Changesets workflow creates or updates the
   package-version release pull request.
3. Review the version, changelog, migration notes, support policy, and packed
   file list before merging the release pull request.
4. Before preparing another release candidate, enter Changesets prerelease mode
   once with `npm exec changeset pre enter rc` and commit `.changeset/pre.json`.
   Confirm `npm run changeset:status` resolves the next `1.0.0-rc.N` version
   before merging the release pull request. Prerelease packages are published
   under npm's `next` distribution tag.
5. Before preparing stable `1.0.0`, run `npm exec changeset pre exit`, version
   packages, review the removal of the prerelease suffix, and commit the
   resulting release changes separately.
6. A stable release also has to correct the README, which npm renders on the
   package page. Two passages describe the opt-in candidate and stop being true
   the moment `latest` moves off `0.8.0`: the **1.0 release candidate** callout
   below the badges, and the install section that documents the `next` channel
   and says an unqualified install still resolves to `0.8.0`. Update both in the
   release pull request, not afterwards. `SUPPORT.md`'s description of the `next`
   tag stays correct, because it describes the process rather than the current
   state.

`1.0.0-rc.1` is a one-time bootstrap exception: its version and changelog were
prepared before Changesets was enabled, so its empty bootstrap changeset does
not create another version bump. Every later RC and stable release requires a
non-empty consumer-facing changeset and follows the release-PR flow above.

## Validate and publish

1. Merge the release commit to `master`, then dispatch `Release Candidate
   Validation` twice for that exact `master` commit. Workflow re-runs reuse the
   same run ID and do not count as two independent validations.
2. Require both independent runs to pass on Ubuntu and Windows, including the
   minimum/latest peer checks, Chrome BiDi/classic capture, Edge smoke, all
   three WDIO frameworks, package validation, coverage, and SBOM generation.
   Advanced behavior runs fully on Linux and as a bounded Windows subset:
   deferred merge, global concurrency, FFmpeg failure/source preservation, and
   retention discard. The Windows job also verifies real process-tree termination
   using two short-lived test-owned Node processes. PR checks run the same subset
   plus targeted ownership/publication/worker tests; this adds one Windows job,
   not another dependency/browser matrix.
3. Dispatch `Publish To npm` from `master`, select `prerelease` or `stable`, and
   provide both successful run IDs. The workflow rejects a stable version on
   the prerelease channel, a prerelease version on the stable channel, duplicate
   runs, failed runs, other workflows, and runs for a different commit.
4. Approve the protected `npm` environment when prompted. The workflow reruns
   the release gates, creates a fresh tarball from that same validated commit,
   publishes it with npm provenance, then creates the matching GitHub release
   with the tarball and CycloneDX SBOM attached.

The workflow requires the selected release channel to match the package version,
then uses `next` for prereleases and `latest` for stable versions. Do not select
`stable` or exit Changesets prerelease mode until the release-candidate
validation has completed cleanly twice and the generated artifacts have been
reviewed.

## Local release gates

```bash
npm run release:check
npm run changeset:status
```

`release:check` regenerates `coverage/lcov.info`, validates the compiled ESM
exports through a temporary packed consumer, and writes `sbom.cdx.json`. Both
generated paths are ignored by Git.
