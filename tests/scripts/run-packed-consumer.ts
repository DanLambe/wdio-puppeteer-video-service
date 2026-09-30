import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { parseArgs } from 'node:util'
import { startPipelineFixture } from '../../scripts/bench/pipeline/fixture.js'
import { parsePackResult } from '../../scripts/check-packed-consumer.js'
import { isVideoManifest } from '../../src/manifest.js'
import { assertAllureVideoAttachments } from '../utils/allure-assertions.js'
import { countFrameColors, probeMediaFile } from '../utils/media-probe.js'
import { assertStaticVideoReport } from '../utils/video-artifact-assertions.js'
import { waitForChildProcess } from './child-process.js'
import { requireE2eFfmpeg } from './ffmpeg-detection.js'

const { values } = parseArgs({
  options: {
    peers: { type: 'string', default: 'installed' },
    protocol: { type: 'string', default: 'bidi' },
    priming: { type: 'string', default: 'on' },
  },
})
assert.ok(
  ['installed', 'minimum', 'latest'].includes(values.peers),
  'Expected installed, minimum, or latest peers',
)
assert.ok(
  ['bidi', 'classic'].includes(values.protocol),
  'Expected bidi or classic protocol',
)
// Without frame priming, as on the `ci` profile, nothing but the recorder's
// own start paints the restored viewport before the static page loads.
assert.ok(
  ['on', 'off'].includes(values.priming),
  'Expected frame priming on or off',
)
assert.ok(
  process.env.npm_execpath,
  'Run through the test:consumer:e2e npm script',
)
const root = path.resolve(import.meta.dirname, '../..')
await fs.mkdir(path.join(root, 'tests/results'), { recursive: true })
const resultsDir = await fs.mkdtemp(
  path.join(
    root,
    'tests/results',
    `consumer-${values.peers}-${values.protocol}${values.priming === 'off' ? '-unprimed' : ''}-`,
  ),
)
const consumer = await fs.mkdtemp(
  path.join(os.tmpdir(), 'wdio-installed-consumer-'),
)
const packages = [
  'webdriverio',
  'puppeteer-core',
  '@wdio/cli',
  '@wdio/local-runner',
  '@wdio/runner',
  '@wdio/mocha-framework',
  '@wdio/globals',
  '@wdio/types',
  '@wdio/reporter',
  '@wdio/spec-reporter',
  '@wdio/allure-reporter',
  'expect-webdriverio',
]
const npm = (args: string[], cwd = consumer) => {
  const result = spawnSync(
    process.execPath,
    [process.env.npm_execpath as string, ...args],
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  )
  assert.equal(
    result.status,
    0,
    `${args.join(' ')} failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`,
  )
  return result.stdout
}

try {
  await fs.cp(path.join(root, 'tests/packed-consumer-e2e'), consumer, {
    recursive: true,
  })
  await fs.copyFile(path.join(root, '.npmrc'), path.join(consumer, '.npmrc'))
  const tarball = parsePackResult(
    npm(
      [
        'pack',
        '--json',
        '--ignore-scripts',
        '--allow-directory=all',
        '--pack-destination',
        consumer,
      ],
      root,
    ),
  )
  const dependencies: Record<string, string> = {
    'wdio-puppeteer-video-service': `file:./${tarball}`,
  }
  for (const name of packages) {
    const special =
      name === 'puppeteer-core'
        ? ['24.11.2', '24']
        : name === 'expect-webdriverio'
          ? ['5.7.0', '6']
          : ['9.29.1', '9']
    dependencies[name] =
      values.peers === 'installed'
        ? (
            JSON.parse(
              await fs.readFile(
                path.join(root, 'node_modules', name, 'package.json'),
                'utf8',
              ),
            ) as { version: string }
          ).version
        : (special[values.peers === 'minimum' ? 0 : 1] as string)
  }
  await fs.writeFile(
    path.join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'video-service-consumer-smoke',
        private: true,
        type: 'module',
        dependencies,
      },
      null,
      2,
    ),
  )
  // Ordinary npm peer resolution. Optional integrations are explicitly installed here;
  // the separate no-peer import test continues to cover their absence.
  console.log(
    `[consumer] Installing ${values.peers} peers into a fresh external project`,
  )
  await fs.writeFile(
    path.join(resultsDir, 'install.log'),
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund']),
  )
  await fs.copyFile(
    path.join(consumer, 'package-lock.json'),
    path.join(resultsDir, 'consumer-lock.json'),
  )
  await fs.writeFile(
    path.join(resultsDir, 'peer-tree.json'),
    npm(['ls', '--all', '--json']),
  )
  const ffmpeg = (await requireE2eFfmpeg()).resolvedPath
  assert.ok(ffmpeg, 'Consumer test requires decoded-media assertions')
  const fixture = await startPipelineFixture()
  const log = createWriteStream(path.join(resultsDir, 'wdio.log'))
  try {
    const child = spawn(
      process.execPath,
      [
        path.join(consumer, 'node_modules/@wdio/cli/bin/wdio.js'),
        'run',
        './wdio.conf.mjs',
      ],
      {
        cwd: consumer,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          FFMPEG_PATH: ffmpeg,
          WDIO_FIXTURE_BASE_URL: fixture.url,
          WDIO_RESULTS_DIR: resultsDir,
          CONSUMER_PROTOCOL: values.protocol,
          CONSUMER_FRAME_PRIMING: values.priming,
        },
      },
    )
    child.stdout.pipe(log, { end: false })
    child.stderr.pipe(log, { end: false })
    await waitForChildProcess(
      child,
      (code) => `Installed consumer exited ${code}; see ${resultsDir}/wdio.log`,
    )
  } finally {
    log.end()
    await finished(log)
    await fixture.close()
  }
  const installedValidation = spawnSync(
    process.execPath,
    ['validate.mjs', path.join(resultsDir, 'manifest.json')],
    { cwd: consumer, encoding: 'utf8', windowsHide: true, timeout: 10_000 },
  )
  assert.equal(installedValidation.status, 0, installedValidation.stderr)
  const manifest: unknown = JSON.parse(
    await fs.readFile(path.join(resultsDir, 'manifest.json'), 'utf8'),
  )
  assert.ok(isVideoManifest(manifest))
  const entries = manifest.runs.flatMap((run) => run.entries)
  assert.equal(entries.length, 1)
  const entry = entries[0]
  assert.ok(entry)
  assert.equal(entry.browser.protocol, `${values.protocol}+cdp`)
  assert.equal(entry.capture.decision, 'recorded')
  assert.equal(entry.result, 'passed')
  assert.equal(entry.capture.segments.length, 1)
  const artifact = entry.capture.segments[0]
  assert.ok(artifact)
  const mediaPath = path.resolve(resultsDir, artifact.path)
  const media = await probeMediaFile(ffmpeg, mediaPath)
  assert.equal(media.width, 960)
  assert.equal(media.height, 600)
  assert.ok(media.durationSeconds >= 1.3)
  const colors = await countFrameColors(ffmpeg, mediaPath, 1)
  assert.ok(colors.green > colors.total * 0.7)
  const expectedTitles = ['retains playable video with reporter and Allure']
  await assertStaticVideoReport({
    resultsDir,
    expectedTitles,
    runLabel: 'consumer',
  })
  await assertAllureVideoAttachments({
    resultsDir,
    expectedTitles,
    runLabel: 'consumer',
  })
  await fs.writeFile(
    path.join(resultsDir, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        peers: values.peers,
        protocol: values.protocol,
        priming: values.priming,
        node: process.version,
        tools: manifest.runs[0]?.tools,
        browser: entry.browser,
        media,
        colors,
      },
      null,
      2,
    ),
  )
  console.log(
    `[consumer] Installed tarball, ${values.peers} peers, ${values.protocol}, frame priming ${values.priming}, media/report/Allure assertions passed. ${resultsDir}`,
  )
} finally {
  await fs.rm(consumer, { recursive: true, force: true, maxRetries: 3 })
}
