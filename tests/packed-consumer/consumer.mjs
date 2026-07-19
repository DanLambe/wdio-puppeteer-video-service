import assert from 'node:assert/strict'
import WdioPuppeteerVideoService, {
  launcher,
  WdioPuppeteerVideoService as NamedService,
} from 'wdio-puppeteer-video-service'
import {
  isVideoManifest,
  MANIFEST_SCHEMA_VERSION,
  validateVideoManifest,
} from 'wdio-puppeteer-video-service/manifest'

assert.equal(WdioPuppeteerVideoService, NamedService)
assert.equal(typeof WdioPuppeteerVideoService, 'function')
assert.equal(typeof launcher, 'function')
assert.notEqual(launcher, WdioPuppeteerVideoService)
assert.equal(typeof launcher.prototype.onPrepare, 'function')
assert.equal(WdioPuppeteerVideoService.prototype.onPrepare, undefined)
assert.equal(MANIFEST_SCHEMA_VERSION, 1)
assert.equal(typeof isVideoManifest, 'function')
assert.equal(typeof validateVideoManifest, 'function')

await assert.rejects(
  import('wdio-puppeteer-video-service/reporter'),
  (error) =>
    error instanceof Error &&
    'code' in error &&
    error.code === 'ERR_MODULE_NOT_FOUND' &&
    error.message.includes('@wdio/reporter'),
)
