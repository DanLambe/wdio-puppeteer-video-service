import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ManifestEntryV1 } from '../../../src/manifest.js'
import { isVideoManifest } from '../../../src/manifest.js'
import type { probeMediaFile as ProbeMediaFile } from '../../../tests/utils/media-probe.js'

type Segment = ManifestEntryV1['capture']['segments'][number]

interface Expectation {
  readonly dwellMs: number
  readonly probeMediaFile: typeof ProbeMediaFile
  /** The switching workload alternates between a static and an animated tab. */
  readonly switching: boolean
}

/** Counts mostly green and mostly red pixels in a few frames a second. */
const sampleColors = async (ffmpeg: string, file: string) => {
  const { stdout } = await promisify(execFile)(
    ffmpeg,
    [
      '-v',
      'error',
      '-nostdin',
      '-i',
      file,
      '-vf',
      'fps=4,scale=16:16',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    {
      encoding: 'buffer',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
    },
  )
  const colors = { red: 0, green: 0, total: stdout.length / 3 }
  for (let i = 0; i < stdout.length; i += 3) {
    const r = stdout[i] as number
    const g = stdout[i + 1] as number
    if (g > r * 2) {
      colors.green += 1
    } else if (r > g * 2) {
      colors.red += 1
    }
  }
  return colors
}

const verifySegment = async (
  directory: string,
  entry: ManifestEntryV1,
  artifact: Segment,
  expectation: Expectation,
) => {
  const file = path.resolve(directory, artifact.path)
  const ffmpeg = process.env.FFMPEG_PATH as string
  const probe = await expectation.probeMediaFile(ffmpeg, file, {
    timeoutMs: 120_000,
  })
  assert.equal(probe.width, 1920)
  assert.equal(probe.height, 1080)
  assert.ok(
    probe.durationSeconds >= expectation.dwellMs / 1_000 - 0.5,
    `Truncated recording: ${artifact.path}`,
  )
  assert.ok(
    probe.durationSeconds <= entry.timings.durationMs / 1_000 + 2.5,
    `Inflated duration: ${artifact.path}`,
  )
  const colors = await sampleColors(ffmpeg, file)
  assert.ok(colors.green > colors.total * 0.1, 'Missing green fixture content')
  const animated = expectation.switching
    ? artifact.tab?.ordinal === 2
    : entry.test?.name.includes('animated')
  if (animated) {
    assert.ok(
      colors.red > colors.total * 0.1,
      'Animation did not preserve both colors',
    )
  } else if (expectation.switching) {
    // A frame or two of the previous tab may open a segment.
    assert.ok(
      colors.red < colors.total * 0.25,
      `Expected the static tab in ${artifact.path}`,
    )
  }
  const bytes = (await stat(file)).size
  assert.equal(bytes, artifact.size)
  return { path: artifact.path, bytes, ...probe, colors }
}

/** Checks an entry's outcome and returns its segments in recording order. */
const readEntrySegments = (
  entry: ManifestEntryV1,
  retain: string,
  segmentsPerEntry: number,
  orderSegments: <T extends { readonly path: string }>(
    segments: readonly T[],
  ) => T[],
): readonly Segment[] => {
  assert.equal(entry.result, 'passed')
  assert.equal(
    entry.capture.decision,
    retain === 'all' ? 'recorded' : 'discarded',
  )
  assert.notEqual(entry.processing.outcome, 'failed')
  assert.equal(
    entry.capture.segments.length,
    retain === 'all' ? segmentsPerEntry : 0,
  )
  if (segmentsPerEntry === 1) {
    return entry.capture.segments
  }
  const segments = orderSegments(entry.capture.segments)
  // The tabs alternate, starting on the first one.
  assert.deepEqual(
    segments.map((segment) => [segment.tab?.ordinal, segment.tab?.reason]),
    segments.map((_, index) => [(index % 2) + 1, index ? 'command' : 'start']),
    'Expected each segment to record the tab its command drove',
  )
  return segments
}

export const verifyPipelineMedia = async (
  directory: string,
  retain: string,
  expectedTests: number,
  dwellMs: number,
  segmentsPerEntry = 1,
) => {
  // Keep the validation oracle independent of the product revision under test.
  const probeModule = '/validation/tests/utils/media-probe.ts'
  const { probeMediaFile } = (await import(
    probeModule
  )) as typeof import('../../../tests/utils/media-probe.js')
  const segmentModule = '/validation/tests/utils/segment-colors.ts'
  const { orderSegments } = (await import(
    segmentModule
  )) as typeof import('../../../tests/utils/segment-colors.js')
  const manifest: unknown = JSON.parse(
    await readFile(path.join(directory, 'manifest.json'), 'utf8'),
  )
  assert.ok(isVideoManifest(manifest), 'Expected finalized Manifest v1')
  const entries = manifest.runs.flatMap((run) => run.entries)
  assert.equal(entries.length, expectedTests)
  const expectation: Expectation = {
    dwellMs,
    probeMediaFile,
    switching: segmentsPerEntry > 1,
  }
  // Validation runs after the measured interval, so segments are probed together.
  const media = await Promise.all(
    entries.flatMap((entry) =>
      readEntrySegments(entry, retain, segmentsPerEntry, orderSegments).map(
        (artifact) => verifySegment(directory, entry, artifact, expectation),
      ),
    ),
  )
  const artifactBytes = media.reduce((total, item) => total + item.bytes, 0)
  return { artifactBytes, media }
}
