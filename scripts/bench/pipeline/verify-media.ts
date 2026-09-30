import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { isVideoManifest } from '../../../src/manifest.js'

export const verifyPipelineMedia = async (
  directory: string,
  retain: string,
  expectedTests: number,
  dwellMs: number,
) => {
  // Keep the validation oracle independent of the product revision under test.
  const probeModule = '/validation/tests/utils/media-probe.ts'
  const { probeMediaFile } = (await import(
    probeModule
  )) as typeof import('../../../tests/utils/media-probe.js')
  const manifest: unknown = JSON.parse(
    await readFile(path.join(directory, 'manifest.json'), 'utf8'),
  )
  assert.ok(isVideoManifest(manifest), 'Expected finalized Manifest v1')
  const entries = manifest.runs.flatMap((run) => run.entries)
  assert.equal(entries.length, expectedTests)
  const media = []
  let artifactBytes = 0
  for (const entry of entries) {
    assert.equal(entry.result, 'passed')
    assert.equal(
      entry.capture.decision,
      retain === 'all' ? 'recorded' : 'discarded',
    )
    assert.notEqual(entry.processing.outcome, 'failed')
    assert.equal(entry.capture.segments.length, retain === 'all' ? 1 : 0)
    for (const artifact of entry.capture.segments) {
      const file = path.resolve(directory, artifact.path)
      const ffmpeg = process.env.FFMPEG_PATH as string
      const probe = await probeMediaFile(ffmpeg, file, { timeoutMs: 120_000 })
      assert.equal(probe.width, 1920)
      assert.equal(probe.height, 1080)
      assert.ok(
        probe.durationSeconds >= dwellMs / 1_000 - 0.5,
        `Truncated recording: ${artifact.path}`,
      )
      assert.ok(
        probe.durationSeconds <= entry.timings.durationMs / 1_000 + 2.5,
        `Inflated duration: ${artifact.path}`,
      )
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
      assert.ok(
        colors.green > colors.total * 0.1,
        'Missing green fixture content',
      )
      if (entry.test?.name.includes('animated')) {
        assert.ok(
          colors.red > colors.total * 0.1,
          'Animation did not preserve both colors',
        )
      }
      const bytes = (await stat(file)).size
      assert.equal(bytes, artifact.size)
      artifactBytes += bytes
      media.push({ path: artifact.path, bytes, ...probe, colors })
    }
  }
  return { artifactBytes, media }
}
