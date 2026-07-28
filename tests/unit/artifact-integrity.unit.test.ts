import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  publishAtomicArtifact,
  reserveArtifactPath,
} from '../../src/service/artifact-integrity.js'
import type { ProcessBoundary } from '../../src/service/boundaries.js'

describe('artifact integrity', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(
      tempDirs.map((tempDir) =>
        fs.rm(tempDir, { recursive: true, force: true }),
      ),
    )
    tempDirs.length = 0
  })

  it('reserves duplicate recording names without overwriting prior media', async () => {
    const tempDir = await createTempDir(tempDirs)
    const desiredPath = path.join(tempDir, 'journey_part1.webm')
    await fs.writeFile(desiredPath, 'existing-media', 'utf8')

    const reservedPath = await reserveArtifactPath(desiredPath)

    expect(reservedPath).toBe(path.join(tempDir, 'journey_run2_part1.webm'))
    await expect(fs.readFile(desiredPath, 'utf8')).resolves.toBe(
      'existing-media',
    )
  })

  it('publishes only after production and validation complete', async () => {
    const tempDir = await createTempDir(tempDirs)
    const desiredPath = path.join(tempDir, 'final.mp4')
    let producedTemporaryPath = ''
    const unlink = vi.spyOn(fs, 'unlink')
    const validate = vi.fn(async (temporaryPath: string) => {
      await expect(fs.readFile(temporaryPath, 'utf8')).resolves.toBe(
        'complete-media',
      )
      await expect(fs.stat(desiredPath)).rejects.toThrow()
      return true
    })

    await expect(
      publishAtomicArtifact({
        desiredPath,
        produce: async (temporaryPath) => {
          producedTemporaryPath = temporaryPath
          expect(temporaryPath).not.toBe(desiredPath)
          expect(path.extname(temporaryPath)).toBe('.mp4')
          await expect(fs.stat(desiredPath)).rejects.toThrow()
          await fs.writeFile(temporaryPath, 'complete-media', 'utf8')
          return true
        },
        validate,
        warn: vi.fn(),
      }),
    ).resolves.toBe(desiredPath)

    expect(validate).toHaveBeenCalledOnce()
    expect(unlink).toHaveBeenCalledWith(producedTemporaryPath)
    await expect(fs.readFile(desiredPath, 'utf8')).resolves.toBe(
      'complete-media',
    )
  })

  it('removes corrupt partial output and preserves source media', async () => {
    const tempDir = await createTempDir(tempDirs)
    const desiredPath = path.join(tempDir, 'final.mp4')
    const sourcePath = path.join(tempDir, 'source.webm')
    const warn = vi.fn()
    await fs.writeFile(sourcePath, 'source-media', 'utf8')

    await expect(
      publishAtomicArtifact({
        desiredPath,
        produce: async (temporaryPath) => {
          await fs.writeFile(temporaryPath, 'partial-media', 'utf8')
          return true
        },
        validate: async () => false,
        warn,
      }),
    ).resolves.toBeUndefined()

    await expect(fs.stat(desiredPath)).rejects.toThrow()
    await expect(fs.readFile(sourcePath, 'utf8')).resolves.toBe('source-media')
    expect(await fs.readdir(tempDir)).toEqual(['source.webm'])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Refusing to publish a corrupt artifact'),
    )
  })

  it('cleans reservations when production fails before writing output', async () => {
    const tempDir = await createTempDir(tempDirs)
    const desiredPath = path.join(tempDir, 'failed.mp4')
    await expect(
      publishAtomicArtifact({
        desiredPath,
        produce: async () => false,
        validate: async () => true,
        warn: vi.fn(),
      }),
    ).resolves.toBeUndefined()
    expect(await fs.readdir(tempDir)).toEqual([])
  })

  it('does not publish or delete a replacement reservation', async () => {
    const tempDir = await createTempDir(tempDirs)
    const desiredPath = path.join(tempDir, 'replacement.webm')
    const reservationPath = `${desiredPath}.wdio-reserve`

    await expect(
      publishAtomicArtifact({
        desiredPath,
        produce: async (temporaryPath) => {
          await fs.writeFile(
            reservationPath,
            JSON.stringify({
              createdAt: Date.now(),
              ownerId: 'replacement-owner',
              outputPath: desiredPath,
              pid: 222,
              temporaryPath: path.join(
                tempDir,
                '.replacement.wdio-222-replacement.webm',
              ),
            }),
            'utf8',
          )
          await fs.writeFile(temporaryPath, 'media', 'utf8')
          return true
        },
        validate: async () => true,
        warn: vi.fn(),
      }),
    ).resolves.toBeUndefined()

    await expect(fs.readFile(reservationPath, 'utf8')).resolves.toContain(
      'replacement-owner',
    )
    await expect(fs.stat(desiredPath)).rejects.toThrow()
  })

  it('rejects empty output and catches producer exceptions', async () => {
    const tempDir = await createTempDir(tempDirs)
    const emptyPath = path.join(tempDir, 'empty.webm')
    const thrownPath = path.join(tempDir, 'thrown.webm')
    const warn = vi.fn()

    await expect(
      publishAtomicArtifact({
        desiredPath: emptyPath,
        produce: async (temporaryPath) => {
          await fs.writeFile(temporaryPath, '')
          return true
        },
        validate: async () => true,
        warn,
      }),
    ).resolves.toBeUndefined()
    await expect(
      publishAtomicArtifact({
        desiredPath: thrownPath,
        produce: async () => {
          throw new Error('producer failed')
        },
        validate: async () => true,
        warn,
      }),
    ).resolves.toBeUndefined()

    expect(warn.mock.calls.flat()).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Refusing to publish an empty artifact'),
        expect.stringContaining('producer failed'),
      ]),
    )
    expect(await fs.readdir(tempDir)).toEqual([])
  })

  it('warns when the output directory cannot be reserved', async () => {
    const tempDir = await createTempDir(tempDirs)
    const blockedDirectory = path.join(tempDir, 'blocked')
    const warn = vi.fn()
    await fs.writeFile(blockedDirectory, 'not-a-directory', 'utf8')

    await expect(
      publishAtomicArtifact({
        desiredPath: path.join(blockedDirectory, 'final.mp4'),
        produce: async () => true,
        validate: async () => true,
        warn,
      }),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to reserve artifact'),
    )
  })

  it('surfaces non-collision reservation errors', async () => {
    const tempDir = await createTempDir(tempDirs)
    const blockedDirectory = path.join(tempDir, 'blocked')
    await fs.writeFile(blockedDirectory, 'not-a-directory', 'utf8')

    await expect(
      reserveArtifactPath(path.join(blockedDirectory, 'final.webm')),
    ).rejects.toMatchObject({ code: expect.stringMatching(/ENOTDIR|EEXIST/u) })
  })

  it('uses the next output name when completed media already exists', async () => {
    const tempDir = await createTempDir(tempDirs)
    const desiredPath = path.join(tempDir, 'existing.webm')
    await fs.writeFile(desiredPath, 'original', 'utf8')

    await expect(
      publishAtomicArtifact({
        desiredPath,
        produce: async (temporaryPath) => {
          await fs.writeFile(temporaryPath, 'replacement', 'utf8')
          return true
        },
        validate: async () => true,
        warn: vi.fn(),
      }),
    ).resolves.toBe(path.join(tempDir, 'existing_run2.webm'))
    await expect(fs.readFile(desiredPath, 'utf8')).resolves.toBe('original')
  })

  it('does not replace output published while acquiring its reservation', async () => {
    const tempDir = await createTempDir(tempDirs)
    const desiredPath = path.join(tempDir, 'raced.webm')
    const reservationPath = `${desiredPath}.wdio-reserve`
    const open = fs.open.bind(fs)

    vi.spyOn(fs, 'open').mockImplementation(async (filePath, flags, mode) => {
      const fileHandle = await open(filePath, flags, mode)
      if (filePath === reservationPath) {
        await fs.writeFile(desiredPath, 'first-worker', 'utf8')
      }
      return fileHandle
    })

    await expect(
      publishAtomicArtifact({
        desiredPath,
        produce: async (temporaryPath) => {
          await fs.writeFile(temporaryPath, 'second-worker', 'utf8')
          return true
        },
        validate: async () => true,
        warn: vi.fn(),
      }),
    ).resolves.toBe(path.join(tempDir, 'raced_run2.webm'))
    await expect(fs.readFile(desiredPath, 'utf8')).resolves.toBe('first-worker')
    await expect(
      fs.readFile(path.join(tempDir, 'raced_run2.webm'), 'utf8'),
    ).resolves.toBe('second-worker')
  })

  it('does not replace output created while producing an artifact', async () => {
    const tempDir = await createTempDir(tempDirs)
    const desiredPath = path.join(tempDir, 'late-collision.webm')
    const warn = vi.fn()

    await expect(
      publishAtomicArtifact({
        desiredPath,
        produce: async (temporaryPath) => {
          await fs.writeFile(temporaryPath, 'processed-media', 'utf8')
          await fs.writeFile(desiredPath, 'direct-recording', 'utf8')
          return true
        },
        validate: async () => true,
        warn,
      }),
    ).resolves.toBeUndefined()
    await expect(fs.readFile(desiredPath, 'utf8')).resolves.toBe(
      'direct-recording',
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to publish artifact'),
    )
    expect(await fs.readdir(tempDir)).toEqual(['late-collision.webm'])
  })

  it('treats output removed by a producer as empty and cleans the reservation', async () => {
    const tempDir = await createTempDir(tempDirs)
    const desiredPath = path.join(tempDir, 'removed.webm')
    const warn = vi.fn()

    await expect(
      publishAtomicArtifact({
        desiredPath,
        produce: async (temporaryPath) => {
          await fs.writeFile(temporaryPath, 'temporary', 'utf8')
          await fs.unlink(temporaryPath)
          return true
        },
        validate: async () => true,
        warn,
      }),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Refusing to publish an empty artifact'),
    )
    expect(await fs.readdir(tempDir)).toEqual([])
  })

  it('does not reclaim a recent malformed reservation', async () => {
    const tempDir = await createTempDir(tempDirs)
    const desiredPath = path.join(tempDir, 'malformed.webm')
    await fs.writeFile(`${desiredPath}.wdio-reserve`, '{', 'utf8')

    await expect(
      publishAtomicArtifact({
        desiredPath,
        produce: async (temporaryPath) => {
          await fs.writeFile(temporaryPath, 'media', 'utf8')
          return true
        },
        validate: async () => true,
        warn: vi.fn(),
      }),
    ).resolves.toBe(path.join(tempDir, 'malformed_run2.webm'))
    await expect(fs.stat(`${desiredPath}.wdio-reserve`)).resolves.toBeDefined()
  })

  it('does not reclaim a reservation owned by a live worker', async () => {
    const tempDir = await createTempDir(tempDirs)
    const desiredPath = path.join(tempDir, 'live.webm')
    await fs.writeFile(
      `${desiredPath}.wdio-reserve`,
      JSON.stringify({
        createdAt: Date.now(),
        outputPath: desiredPath,
        pid: 222,
        temporaryPath: path.join(tempDir, '.live.wdio-222-active.webm'),
      }),
      'utf8',
    )

    await expect(
      publishAtomicArtifact({
        desiredPath,
        process: {
          environment: () => undefined,
          isAlive: (pid) => pid === 222,
          pid: 333,
          platform: 'linux',
        },
        produce: async (temporaryPath) => {
          await fs.writeFile(temporaryPath, 'media', 'utf8')
          return true
        },
        validate: async () => true,
        warn: vi.fn(),
      }),
    ).resolves.toBe(path.join(tempDir, 'live_run2.webm'))
    await expect(fs.stat(`${desiredPath}.wdio-reserve`)).resolves.toBeDefined()
  })

  it('does not reclaim a reservation whose ownership changes during cleanup', async () => {
    const tempDir = await createTempDir(tempDirs)
    const desiredPath = path.join(tempDir, 'ownership-race.webm')
    const reservationPath = `${desiredPath}.wdio-reserve`
    const temporaryPath = path.join(
      tempDir,
      '.ownership-race.wdio-222-old.webm',
    )
    await fs.writeFile(
      reservationPath,
      JSON.stringify({
        createdAt: Date.now(),
        ownerId: 'old-owner',
        outputPath: desiredPath,
        pid: 222,
        temporaryPath,
      }),
      'utf8',
    )

    await expect(
      publishAtomicArtifact({
        desiredPath,
        process: {
          environment: () => undefined,
          isAlive: () => {
            writeFileSync(
              reservationPath,
              JSON.stringify({
                createdAt: Date.now(),
                ownerId: 'replacement-owner',
                outputPath: desiredPath,
                pid: 333,
                temporaryPath: path.join(
                  tempDir,
                  '.ownership-race.wdio-333-new.webm',
                ),
              }),
              'utf8',
            )
            return false
          },
          pid: 444,
          platform: 'linux',
        },
        produce: async (outputPath) => {
          await fs.writeFile(outputPath, 'media', 'utf8')
          return true
        },
        validate: async () => true,
        warn: vi.fn(),
      }),
    ).resolves.toBe(path.join(tempDir, 'ownership-race_run2.webm'))
    await expect(fs.readFile(reservationPath, 'utf8')).resolves.toContain(
      'replacement-owner',
    )
  })

  it('reclaims an expired malformed reservation', async () => {
    const tempDir = await createTempDir(tempDirs)
    const desiredPath = path.join(tempDir, 'expired.webm')
    const reservationPath = `${desiredPath}.wdio-reserve`
    await fs.writeFile(reservationPath, '{', 'utf8')
    const expired = new Date(0)
    await fs.utimes(reservationPath, expired, expired)

    await expect(
      publishAtomicArtifact({
        desiredPath,
        produce: async (temporaryPath) => {
          await fs.writeFile(temporaryPath, 'media', 'utf8')
          return true
        },
        validate: async () => true,
        warn: vi.fn(),
      }),
    ).resolves.toBe(desiredPath)
    await expect(fs.stat(reservationPath)).rejects.toThrow()
  })

  it('reclaims expired reservations with missing or empty owner tokens', async () => {
    const tempDir = await createTempDir(tempDirs)
    for (const [name, ownerId, includeOutputPath] of [
      ['missing-owner', undefined, true],
      ['empty-owner', '', true],
      ['missing-output', 'owner-token', false],
    ] as const) {
      const desiredPath = path.join(tempDir, `${name}.webm`)
      const reservationPath = `${desiredPath}.wdio-reserve`
      await fs.writeFile(
        reservationPath,
        JSON.stringify({
          createdAt: Date.now(),
          ...(ownerId === undefined ? {} : { ownerId }),
          ...(includeOutputPath ? { outputPath: desiredPath } : {}),
          pid: 222,
          temporaryPath: path.join(tempDir, `.${name}.wdio-222-old.webm`),
        }),
        'utf8',
      )
      const expired = new Date(0)
      await fs.utimes(reservationPath, expired, expired)

      await expect(
        publishAtomicArtifact({
          desiredPath,
          process: {
            environment: () => undefined,
            isAlive: () => false,
            pid: 444,
            platform: 'linux',
          },
          produce: async (temporaryPath) => {
            await fs.writeFile(temporaryPath, 'media', 'utf8')
            return true
          },
          validate: async () => true,
          warn: vi.fn(),
        }),
      ).resolves.toBe(desiredPath)
    }
  })

  it('recovers reservations and temporary output left by a killed worker', async () => {
    const tempDir = await createTempDir(tempDirs)
    const desiredPath = path.join(tempDir, 'final.webm')
    const abandonedPath = path.join(tempDir, '.final.wdio-99999-abandoned.webm')
    const reservationPath = `${desiredPath}.wdio-reserve`
    await fs.writeFile(abandonedPath, 'partial', 'utf8')
    await fs.writeFile(
      reservationPath,
      JSON.stringify({
        createdAt: Date.now(),
        ownerId: 'abandoned-owner',
        outputPath: desiredPath,
        pid: 99999,
        temporaryPath: abandonedPath,
      }),
      'utf8',
    )
    const processBoundary: ProcessBoundary = {
      environment: () => undefined,
      isAlive: () => false,
      pid: 12345,
      platform: 'linux',
    }

    await expect(
      publishAtomicArtifact({
        desiredPath,
        process: processBoundary,
        produce: async (temporaryPath) => {
          expect(path.basename(temporaryPath)).toContain('.wdio-12345-')
          await fs.writeFile(temporaryPath, 'recovered-media', 'utf8')
          return true
        },
        validate: async () => true,
        warn: vi.fn(),
      }),
    ).resolves.toBe(desiredPath)

    await expect(fs.stat(abandonedPath)).rejects.toThrow()
    await expect(fs.stat(reservationPath)).rejects.toThrow()
  })

  it('does not delete paths that forged reservation metadata does not own', async () => {
    const tempDir = await createTempDir(tempDirs)
    const desiredPath = path.join(tempDir, 'final.webm')
    const protectedPath = path.join(tempDir, 'protected.webm')
    await fs.writeFile(protectedPath, 'keep-me', 'utf8')
    await fs.writeFile(
      `${desiredPath}.wdio-reserve`,
      JSON.stringify({
        createdAt: Date.now(),
        ownerId: 'forged-owner',
        outputPath: desiredPath,
        pid: 99999,
        temporaryPath: protectedPath,
      }),
      'utf8',
    )

    await expect(
      publishAtomicArtifact({
        desiredPath,
        process: {
          environment: () => undefined,
          isAlive: () => false,
          pid: 12345,
          platform: 'linux',
        },
        produce: async (temporaryPath) => {
          await fs.writeFile(temporaryPath, 'new-media', 'utf8')
          return true
        },
        validate: async () => true,
        warn: vi.fn(),
      }),
    ).resolves.toBe(desiredPath)
    await expect(fs.readFile(protectedPath, 'utf8')).resolves.toBe('keep-me')
  })

  it('coordinates concurrent workers with exclusive final reservations', async () => {
    const tempDir = await createTempDir(tempDirs)
    const desiredPath = path.join(tempDir, 'shared.mp4')
    const publish = (contents: string) =>
      publishAtomicArtifact({
        desiredPath,
        produce: async (temporaryPath) => {
          await fs.writeFile(temporaryPath, contents, 'utf8')
          return true
        },
        validate: async () => true,
        warn: vi.fn(),
      })

    const publishedPaths = await Promise.all([
      publish('worker-a'),
      publish('worker-b'),
    ])

    expect(new Set(publishedPaths)).toEqual(
      new Set([desiredPath, path.join(tempDir, 'shared_run2.mp4')]),
    )
    await expect(
      Promise.all(
        publishedPaths.map((publishedPath) =>
          fs.readFile(publishedPath ?? '', 'utf8'),
        ),
      ),
    ).resolves.toEqual(expect.arrayContaining(['worker-a', 'worker-b']))
  })

  it('prevents overwrites across independent Node worker processes', async () => {
    const tempDir = await createTempDir(tempDirs)
    const desiredPath = path.join(tempDir, 'multiprocess.webm')
    const publishedPaths = await Promise.all([
      runPublisherChild(desiredPath, 'child-a'),
      runPublisherChild(desiredPath, 'child-b'),
    ])

    expect(new Set(publishedPaths)).toEqual(
      new Set([desiredPath, path.join(tempDir, 'multiprocess_run2.webm')]),
    )
    await expect(
      Promise.all(
        publishedPaths.map((publishedPath) =>
          fs.readFile(publishedPath, 'utf8'),
        ),
      ),
    ).resolves.toEqual(expect.arrayContaining(['child-a', 'child-b']))
  })

  it('recovers the real reservation of a terminated Node worker', async () => {
    const tempDir = await createTempDir(tempDirs)
    const desiredPath = path.join(tempDir, 'terminated-worker.webm')
    await terminatePublisherAfterReservation(desiredPath)

    await expect(
      publishAtomicArtifact({
        desiredPath,
        produce: async (temporaryPath) => {
          await fs.writeFile(temporaryPath, 'replacement-media', 'utf8')
          return true
        },
        validate: async () => true,
        warn: vi.fn(),
      }),
    ).resolves.toBe(desiredPath)
    await expect(fs.readFile(desiredPath, 'utf8')).resolves.toBe(
      'replacement-media',
    )
    expect(await fs.readdir(tempDir)).toEqual(['terminated-worker.webm'])
  })
})

const createTempDir = async (tempDirs: string[]): Promise<string> => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wdio-video-artifact-integrity-'),
  )
  tempDirs.push(tempDir)
  return tempDir
}

const runPublisherChild = (
  desiredPath: string,
  contents: string,
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        path.resolve('tests/scripts/artifact-publisher-child.ts'),
        desiredPath,
        contents,
      ],
      { windowsHide: true },
    )
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(
        new Error(`Artifact publisher exited with ${String(code)}: ${stderr}`),
      )
    })
  })
}

const terminatePublisherAfterReservation = (
  desiredPath: string,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        path.resolve('tests/scripts/artifact-publisher-child.ts'),
        desiredPath,
        'abandoned-media',
        'hang',
      ],
      { windowsHide: true },
    )
    let ready = false
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Timed out waiting for child reservation: ${stderr}`))
    }, 10_000)
    timeout.unref?.()
    child.stdout?.on('data', (chunk: Buffer) => {
      if (!chunk.toString('utf8').includes('READY')) {
        return
      }
      ready = true
      child.kill('SIGKILL')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(timeout)
      if (!ready) {
        reject(
          new Error(`Child exited before reserving its artifact: ${stderr}`),
        )
        return
      }
      resolve()
    })
  })
}
