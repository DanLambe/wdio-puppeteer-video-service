import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
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
    const filePath = path.resolve(resultsDir, artifact.path)
    const media = await probeMediaFile(ffmpegPath, filePath)
    assert.equal(
      artifact.size,
      (await stat(filePath)).size,
      `Manifest size for ${artifact.path}`,
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

// The capture window runs from after startup (frame priming) until the segment
// is finalized, while the video starts at the first screencast frame, so allow
// the startup time above it. A recording that plays far longer than its capture
// took has an inflated timeline. The window also includes stream flushing and
// media probing after stop, which can take seconds on a slow runner, so it is
// no lower bound; wdio.capture.conf.ts checks the decoded frame rate instead.
const PLAYBACK_STARTUP_ALLOWANCE_SECONDS = 2.5

export const assertManifestPlaybackMatchesCapture = async (
  resultsDir: string,
  ffmpegPath: string | undefined,
  speed: number,
): Promise<void> => {
  assert.ok(ffmpegPath, 'FFMPEG_PATH is required for manifest media assertions')
  const manifest: unknown = JSON.parse(
    await readFile(path.join(resultsDir, 'manifest.json'), 'utf8'),
  )
  assert.ok(isVideoManifest(manifest), 'Expected a valid finalized manifest')
  const entries = manifest.runs.flatMap((run) => run.entries)
  let verified = 0
  for (const entry of entries) {
    const [segment] = entry.capture.segments
    const { captureStartedAt, captureStoppedAt } = entry.timings
    if (!segment || entry.capture.segments.length !== 1) {
      continue
    }
    assert.ok(
      captureStartedAt && captureStoppedAt,
      `Expected capture timings for ${segment.path}`,
    )
    const captureSeconds =
      (Date.parse(captureStoppedAt) - Date.parse(captureStartedAt)) / 1_000
    const media = await probeMediaFile(
      ffmpegPath,
      path.resolve(resultsDir, segment.path),
    )
    const playedSeconds = media.durationSeconds * speed
    assert.ok(
      playedSeconds <= captureSeconds + PLAYBACK_STARTUP_ALLOWANCE_SECONDS,
      `Expected ${segment.path} to play back no longer than its ${captureSeconds.toFixed(2)}s capture; it plays ${playedSeconds.toFixed(2)}s at speed ${speed.toString()}`,
    )
    verified += 1
  }
  assert.ok(verified > 0, 'Expected a single-segment recording to time')
  console.log(
    `[e2e:manifest] Verified real-time playback for ${verified.toString()} recordings.`,
  )
}
