import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { isVideoManifest } from 'wdio-puppeteer-video-service/manifest'

// The launcher finalizes after config onComplete hooks, so validate after WDIO exits.
const manifest = JSON.parse(await fs.readFile(process.argv[2], 'utf8'))
assert.ok(
  isVideoManifest(manifest),
  'Installed Manifest v1 validator rejected launcher output',
)
assert.equal(manifest.runs.length, 1)
