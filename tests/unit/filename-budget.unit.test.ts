import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Frameworks } from '@wdio/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getCollisionPath,
  publishAtomicArtifact,
  reserveArtifactPath,
} from '../../src/service/artifact-integrity.js'
import { SpoolSink } from '../../src/service/frame-sink.js'
import { moveSpoolToFramesFile } from '../../src/service/frames-file.js'
import {
  computeMaxSlugLength,
  getEffectiveMaxFilenameLength,
} from '../../src/service/normalization.js'
import { resolveServiceConfiguration } from '../../src/service/options.js'
import { getSegmentPath } from '../../src/service/paths.js'
import { formatSpoolFileName } from '../../src/service/spool-name.js'
import {
  buildTestSlugFromMetadata,
  collectSlugMetadata,
} from '../../src/video-name-utils.js'

// Every file the service derives from a segment's name must fit one path
// component: 255 bytes on ext4, APFS and overlayfs, 255 UTF-16 units on NTFS.
// Slugs are ASCII, so their length is their size in either.
const COMPONENT_MAX = 255

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  )
})

const UUID = '11111111-2222-4333-8444-555555555555'
// The longest process ID any supported platform hands out.
const WIDEST_PID = '4294967295'

/** Every name derived from one segment, at its widest. */
const derivedNames = (slug: string) => {
  const segment = path.basename(getSegmentPath('videos', slug, 9999, 'webm'))
  const collision = path.basename(getCollisionPath(segment, 1000))
  const collisionName = path.parse(collision).name
  return {
    segment,
    collision,
    reservation: `${collision}.wdio-reserve`,
    frames: `${collisionName}.frames.mkv`,
    spool: formatSpoolFileName({ part: 9999, slug, uuid: UUID }) ?? '',
    temporary: `.${collisionName}.wdio-${WIDEST_PID}-${UUID}.webm`,
    mergedTemporary: `.${slug}_run1000.wdio-${WIDEST_PID}-${UUID}.webm`,
    concatList: `${slug}_run1000_concat_${UUID}.txt`,
  }
}

const longTitle =
  'checkout scenario outline with a very long descriptive name '.repeat(6)

const slugFor = (maxSlugLength: number, retry?: number): string =>
  buildTestSlugFromMetadata(
    collectSlugMetadata(
      {
        title: longTitle,
        parent: 'suite',
        file: 'tests/long.spec.ts',
        ...(retry === undefined ? {} : { _currentRetry: retry }),
      } as Frameworks.Test,
      undefined,
      'test',
    ),
    {
      maxSlugLength,
      fileNameStyle: 'test',
      fileNameOverflowStrategy: 'truncate',
      sessionIdToken: 'sess_12345678',
      sessionIdFullToken: 'sess_12345678',
    },
  )

describe('file name budget', () => {
  it.each([
    { platform: 'linux', maxLength: undefined },
    { platform: 'darwin', maxLength: undefined },
    { platform: 'win32', maxLength: undefined },
    { platform: 'linux', maxLength: 255 },
    { platform: 'linux', maxLength: 400 },
    { platform: 'linux', maxLength: 180 },
    { platform: 'darwin', maxLength: 80 },
    { platform: 'win32', maxLength: 255 },
    { platform: 'linux', maxLength: 40 },
  ] as const)(
    'fits every derived name in one component on $platform with maxLength $maxLength',
    ({ platform, maxLength }) => {
      const options = {
        outputDir: 'videos',
        ...(maxLength === undefined ? {} : { maxFileNameLength: maxLength }),
      }
      const maxSlug = computeMaxSlugLength(options, platform)
      const names = derivedNames('a'.repeat(maxSlug))

      expect(names.segment.length).toBeLessThanOrEqual(
        getEffectiveMaxFilenameLength(options, platform),
      )
      for (const [kind, name] of Object.entries(names)) {
        expect(
          Buffer.byteLength(name, 'utf8'),
          `${kind} ${name.length.toString()}`,
        ).toBeLessThanOrEqual(COMPONENT_MAX)
      }
    },
  )

  it('keeps the Windows default slug length', () => {
    expect(computeMaxSlugLength({ outputDir: 'videos' }, 'win32')).toBe(166)
  })

  it('opens every derived file of a long retried test title', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'name-budget-'))
    tempDirs.push(dir)
    const { maxSlugLength } = resolveServiceConfiguration(
      { outputDir: dir, capture: { encoding: 'auto' } },
      'linux',
    )
    const slug = slugFor(maxSlugLength, 1)
    const plannedPath = getSegmentPath(dir, slug, 1, 'webm')

    const spoolName = formatSpoolFileName({ part: 1, slug, uuid: UUID })
    expect(spoolName).toBeDefined()
    const sink = new SpoolSink({
      path: path.join(dir, spoolName ?? ''),
      settings: {
        canvas: { width: 16, height: 16 },
        format: 'webm',
        quality: 80,
        scale: 1,
      },
    })
    const opened = await Promise.race([
      sink.ready.then(() => 'ready'),
      sink.failed.then((error) => error.message),
    ])
    expect(opened).toBe('ready')
    await sink.abort()

    const spoolPath = path.join(dir, `${slug}_part1.${UUID}.mkv`)
    await fs.writeFile(spoolPath, 'frames')
    const moved = await moveSpoolToFramesFile({
      linkFile: fs.link,
      plannedPath,
      removeSpool: async (file) => {
        await fs.rm(file)
        return true
      },
      spoolPath,
    })
    expect(moved).toMatchObject({ spoolRemoved: true })

    const reserved = await reserveArtifactPath(plannedPath)
    expect(reserved).toBe(plannedPath)
    const temporaryNames: string[] = []
    const published = await publishAtomicArtifact({
      desiredPath: plannedPath,
      produce: async (temporaryPath) => {
        temporaryNames.push(path.basename(temporaryPath))
        await fs.writeFile(temporaryPath, 'video')
        return true
      },
      validate: async () => true,
      warn: () => undefined,
    })
    expect(published).toBe(getCollisionPath(plannedPath, 2))
    expect(temporaryNames).toHaveLength(1)
  })
})
