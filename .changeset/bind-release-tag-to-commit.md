---
'wdio-puppeteer-video-service': patch
---

Create the GitHub release tag at the exact commit the release was validated and
built from. The release step named a tag but no target, and the create-release
API tags the default branch's current tip when the tag is new, so a `master`
that advanced while the publish job waited for its protected-environment
approval could leave the tag, its source archives, and the published tarball's
provenance describing different commits. The publish job now also refuses to
continue when a tag for that version already exists at another commit, because
an existing tag makes the target inert; it never moves or deletes one.
