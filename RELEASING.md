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
4. A new major is released as candidates first. Enter Changesets prerelease
   mode once with `npm exec changeset pre enter rc` and commit
   `.changeset/pre.json`. Confirm `npm run changeset:status` resolves the next
   `N.0.0-rc.M` version before merging the release pull request. Prerelease
   packages are published under npm's `next` distribution tag. 2.0 is in this
   mode: its major changeset is `.changeset/wdio-10-support.md`.
5. Before preparing the stable release, run `npm exec changeset pre exit`,
   version packages, review the removal of the prerelease suffix, and commit the
   resulting release changes separately.
6. A stable release also has to correct the README, which npm renders on the
   package page. Two passages describe the opt-in candidate and stop being true
   the moment `latest` moves to the new major: the **release candidate** callout
   below the badges, and the install section that documents the `next` channel
   and says an unqualified install still resolves to the previous major. Update
   both in the release pull request, not afterwards. `SUPPORT.md`'s description
   of the `next` tag stays correct, because it describes the process rather
   than the current state.

`1.0.0-rc.1` was a one-time bootstrap exception: its version and changelog were
prepared before Changesets was enabled. Every other RC and stable release
requires a non-empty consumer-facing changeset and follows the release-PR flow
above.

## Maintenance releases for an older major

Once 2.0 is stable, 1.x keeps receiving fixes for WebdriverIO 9 from the
`release/1.x` branch, published under npm's `wdio9` tag so a 1.x patch never
moves `latest`. `scripts/resolve-release-channel.ts` enforces this. It refuses
a 1.x version from any branch but `release/1.x`, a 1.x prerelease, and a later
major from any branch but `master`. The publish workflow passes it the
dispatched branch.

Setting up the branch, once:

1. Create `release/1.x` from the `1.0.0` release commit and push it.
2. On it, apply the release plumbing from the 2.0 work:
   - `scripts/resolve-release-channel.ts` and its tests;
   - the `Publish To npm` workflow's branch and validation-run checks, and its
     `make_latest` setting;
   - `.changeset/config.json` `baseBranch` set to `release/1.x`;
   - `release/1.x` added to the branch filters of `release-pr.yaml` and
     `pull-request-checks.yaml`.
3. Protect `release/1.x` like `master`.

Then, for each 1.x fix:

1. Open the pull request against `release/1.x` with a patch changeset.
2. Merge the Changesets release pull request on `release/1.x`.
3. Dispatch `Release Candidate Validation` twice on `release/1.x` for the
   release commit. Then dispatch `Publish To npm` from `release/1.x` with the
   `stable` channel and both run IDs. The package is published under `wdio9`.
   Its GitHub release is not marked latest.

A fix that applies to both majors lands on `master` first and is then ported to
`release/1.x`, leaving out anything that needs WebdriverIO 10.

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
   the prerelease channel, a prerelease version on the stable channel, a version
   whose major belongs to another branch, duplicate runs, failed runs, other
   workflows, and runs for a different commit or branch.
4. Approve the protected `npm` environment when prompted. The workflow reruns
   the release gates, creates a fresh tarball from that same validated commit,
   publishes it with npm provenance, then creates the matching GitHub release
   with the tarball and CycloneDX SBOM attached.

The workflow requires the selected release channel to match the package version,
then uses `next` for prereleases and `latest` for stable versions on `master`,
and `wdio9` for 1.x on `release/1.x`. Do not select
`stable` or exit Changesets prerelease mode until the release-candidate
validation has completed cleanly twice and the generated artifacts have been
reviewed.

## Local release gates

```bash
npm run release:check
npm run changeset:status
npm run check:install-scripts
```

`release:check` regenerates `coverage/lcov.info`, validates the compiled ESM
exports through a temporary packed consumer, and writes `sbom.cdx.json`. Both
generated paths are ignored by Git.

## Install scripts and fresh releases

`.npmrc` enables `strict-allow-scripts` and `min-release-age=2`. CI installs
without running scripts, then rebuilds only the approved binaries
(`esbuild`, `ffmpeg-static`).

- `npm run check:install-scripts` lists installed packages whose install scripts
  `package.json` `allowScripts` does not cover, using npm's own policy matching,
  and fails if there are any. Pull request checks run it on the lockfile, and
  every release-validation job runs it after its lock-free install, before any
  rebuild.
- The `Install Script Drift` workflow resolves the minimum and latest supported
  peer stacks every Monday, and on demand, without running scripts, so a new
  upstream package with an install script is reported before a release.
- When the check reports a package, review its script. Deny a script the project
  does not need with a name-only entry such as `"edgedriver": false`, which also
  covers future versions. Approve a required script only for the exact reviewed
  version, such as `"esbuild@0.28.2": true`. Never approve all scripts.
- Lock-free validation installs honor `min-release-age`, so "latest" means the
  newest release that is at least two days old. A same-day upstream publish
  cannot change results between validation jobs or reruns.