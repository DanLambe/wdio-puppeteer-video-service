import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isVideoManifest } from '../../src/manifest.js'
import { probeMediaFile } from './media-probe.js'

export const assertManifestMediaDimensions = async (
  resultsDir: string,
  ffmpegPath: string | undefined,
): Promise<void> => {
  assert.ok(ffmpegPath, 'FFMPEG_PATH is required for manifest media assertions')
  const manifest: unknown = JSON.parse(
    await readFile(path.join(resultsDir, 'manifest.json'), 'utf8'),
  )
  assert.ok(isVideoManifest(manifest), 'Expected a valid finalized manifest')
  const artifacts = manifest.runs.flatMap((run) =>
    run.entries.flatMap((entry) => entry.capture.segments),
  )
  assert.ok(artifacts.length > 0, 'Expected retained artifacts to verify')
  for (const artifact of artifacts) {
    const media = await probeMediaFile(
      ffmpegPath,
      path.resolve(resultsDir, artifact.path),
    )
    assert.equal(
      artifact.width,
      media.width,
      `Manifest width for ${artifact.path}`,
    )
    assert.equal(
      artifact.height,
      media.height,
      `Manifest height for ${artifact.path}`,
    )
  }
  console.log(
    `[e2e:manifest] Verified encoded dimensions for ${artifacts.length.toString()} retained artifacts.`,
  )
}
