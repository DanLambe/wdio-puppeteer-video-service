---
'wdio-puppeteer-video-service': patch
---

Allow the static report's own style and script blocks by SHA-256 hash instead of
a nonce. A nonce is only worth anything when it is unpredictable, and a report
generated once and read from disk has no per-request secret to derive one from,
so the previous value was reproducible from the report itself. The digests are
computed from the exact emitted text, so an edited or tampered block stops
matching and the browser refuses to run it, and the report stays byte-identical
across runs. The ineffective `frame-ancestors` directive is dropped, because a
policy delivered in a `<meta>` element cannot carry it; hosts that need to
restrict embedding should send a response header. Escaping is unchanged and
remains the primary defense.
