import { type ChildProcess, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ClockBoundary,
  type FileSystemBoundary,
  nodeFileSystem,
  type ProcessBoundary,
} from '../../src/service/boundaries.js'
import {
  cleanupStaleOwnedFileLease,
  isTransientLeaseFileError,
  OWNED_FILE_LEASE_SCHEMA_VERSION,
  OwnedFileLease,
  OwnedFileLeaseOperationalError,
  parseOwnedFileLeaseMetadata,
  tryAcquireOwnedFileLease,
} from '../../src/service/owned-file-lease.js'

const createProcess = (
  pid = 12345,
  isAlive: (candidatePid: number) => boolean = () => true,
): ProcessBoundary => ({
  environment: () => undefined,
  isAlive,
  pid,
  platform: process.platform,
})

const createClock = (
  initialNow = 1_000,
): ClockBoundary & {
  setNow(value: number): void
} => {
  let now = initialNow
  return {
    clearInterval: vi.fn(),
    clearTimeout: vi.fn(),
    delay: async (milliseconds) => {
      now += milliseconds
    },
    now: () => now,
    queueMicrotask,
    setInterval: vi.fn(() => ({}) as NodeJS.Timeout),
    setNow(value): void {
      now = value
    },
    setTimeout: vi.fn(() => ({ unref: vi.fn() }) as unknown as NodeJS.Timeout),
  }
}

describe('owned file lease', () => {
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

  it.each([
    { code: 'EBUSY', platform: 'linux', transient: true },
    { code: 'EAGAIN', platform: 'linux', transient: true },
    { code: 'EMFILE', platform: 'linux', transient: true },
    { code: 'ENFILE', platform: 'linux', transient: true },
    { code: 'EPERM', platform: 'win32', transient: true },
    { code: 'EPERM', platform: 'linux', transient: false },
    { code: 'EACCES', platform: 'win32', transient: false },
    { code: 'ENOSPC', platform: 'win32', transient: false },
    { code: undefined, platform: 'win32', transient: false },
  ] as const)(
    'classifies $code on $platform as transient=$transient',
    ({ code, platform, transient }) => {
      const errno = Object.assign(new Error('refused'), { code })
      expect(isTransientLeaseFileError(errno, platform)).toBe(transient)
      expect(
        isTransientLeaseFileError(
          new OwnedFileLeaseOperationalError('/lease', 'open', errno),
          platform,
        ),
      ).toBe(transient)
    },
  )

  it.each([undefined, null, 'EBUSY', { code: 'EBUSY' }])(
    'treats the non-error cause %j as a real fault',
    (cause) => {
      expect(isTransientLeaseFileError(cause, 'win32')).toBe(false)
      expect(
        isTransientLeaseFileError(
          new OwnedFileLeaseOperationalError('/lease', 'open', cause),
          'win32',
        ),
      ).toBe(false)
    },
  )

  it('writes versioned ownership metadata and releases idempotently', async () => {
    const leasePath = await createLeasePath(tempDirs)
    const clock = createClock(100)
    const lease = await tryAcquireOwnedFileLease(
      {
        filePath: leasePath,
        invalidStaleMs: 100,
        payload: { resource: 'test' },
      },
      { clock, process: createProcess() },
    )

    expect(lease).toBeDefined()
    expect(readJson(await fs.readFile(leasePath, 'utf8'))).toMatchObject({
      schemaVersion: OWNED_FILE_LEASE_SCHEMA_VERSION,
      ownerToken: lease?.ownerToken,
      pid: 12345,
      createdAt: 100,
      updatedAt: 100,
      payload: { resource: 'test' },
    })
    expect(clock.setInterval).not.toHaveBeenCalled()

    await expect(lease?.release()).resolves.toBe(true)
    await expect(lease?.release()).resolves.toBe(true)
    expect(clock.clearInterval).not.toHaveBeenCalled()
    await expect(fs.stat(leasePath)).rejects.toThrow()
  })

  it('reclaims a future-format lease only when its owner is dead', async () => {
    const leasePath = await createLeasePath(tempDirs)
    await fs.writeFile(
      leasePath,
      JSON.stringify({ schemaVersion: 2, ownerToken: 'future', pid: 222 }),
      'utf8',
    )

    await expect(
      cleanupStaleOwnedFileLease(
        { filePath: leasePath, invalidStaleMs: 10_000 },
        { process: createProcess(333, () => false) },
      ),
    ).resolves.toBe(true)
    await expect(fs.stat(leasePath)).rejects.toThrow()
  })

  it('keeps ownership metadata immutable while a lease is held', async () => {
    const leasePath = await createLeasePath(tempDirs)
    const clock = createClock(100)
    const lease = await tryAcquireOwnedFileLease(
      { filePath: leasePath, invalidStaleMs: 100 },
      { clock, process: createProcess() },
    )
    const originalMetadata = await fs.readFile(leasePath, 'utf8')
    clock.setNow(250)
    await Promise.resolve()

    await expect(fs.readFile(leasePath, 'utf8')).resolves.toBe(originalMetadata)
    expect(readJson(originalMetadata)).toMatchObject({
      createdAt: 100,
      updatedAt: 100,
    })
    expect(clock.setInterval).not.toHaveBeenCalled()
    await lease?.release()
  })

  it('captures fallback file identity after writing lease metadata', async () => {
    const close = vi.fn(async () => {})
    let statCalls = 0
    let contents = ''
    let exists = true
    const fileHandle = {
      close,
      stat: async () => {
        statCalls += 1
        return statCalls === 1
          ? { mtimeMs: 1, size: 0 }
          : { mtimeMs: 2, size: contents.length }
      },
      truncate: async () => {
        contents = ''
      },
      write: async (buffer: Buffer, offset: number, length: number) => {
        contents += buffer.subarray(offset, offset + length).toString('utf8')
        return { bytesWritten: length }
      },
    }
    const fileSystem: FileSystemBoundary = {
      ...nodeFileSystem,
      openExclusive: async () => fileHandle as never,
      readText: async () => contents,
      stat: async () => {
        if (!exists) {
          throw new Error('missing')
        }
        return { mtimeMs: 2, size: contents.length }
      },
      unlink: async () => {
        exists = false
      },
    }

    const lease = await tryAcquireOwnedFileLease(
      { filePath: 'lease.lock', invalidStaleMs: 100 },
      { fileSystem, randomId: () => 'owner-token' },
    )

    expect(lease).toBeDefined()
    await expect(lease?.release()).resolves.toBe(true)
    expect(close).toHaveBeenCalledOnce()
  })

  it('preserves a same-file replacement with a different owner token', async () => {
    const leasePath = await createLeasePath(tempDirs)
    const lease = await tryAcquireOwnedFileLease(
      { filePath: leasePath, invalidStaleMs: 100 },
      { process: createProcess() },
    )
    await fs.writeFile(
      leasePath,
      JSON.stringify({
        schemaVersion: OWNED_FILE_LEASE_SCHEMA_VERSION,
        ownerToken: 'replacement-owner',
        pid: 22222,
        createdAt: 1,
        updatedAt: 1,
      }),
      'utf8',
    )

    await expect(lease?.isOwner()).resolves.toBe(false)
    await expect(lease?.release()).resolves.toBe(false)
    await expect(fs.readFile(leasePath, 'utf8')).resolves.toContain(
      'replacement-owner',
    )
  })

  it('requires file identity as well as the owner token', async () => {
    const close = vi.fn(async () => {})
    const contents = JSON.stringify({
      schemaVersion: OWNED_FILE_LEASE_SCHEMA_VERSION,
      ownerToken: 'owner-token',
      pid: 12345,
      createdAt: 1,
      updatedAt: 1,
    })
    const fileSystem = {
      ...nodeFileSystem,
      readText: async () => contents,
      stat: async () => ({ dev: 2, ino: 2, mtimeMs: 1, size: 1 }),
      unlink: vi.fn(async () => {}),
    }
    const lease = new OwnedFileLease({
      createdAt: 1,
      fileHandle: { close } as never,
      fileIdentity: { dev: 1, ino: 1, mtimeMs: 1, size: 1 },
      filePath: 'lease.lock',
      fileSystem,
      ownerToken: 'owner-token',
      pid: 12345,
    })

    await expect(lease.isOwner()).resolves.toBe(false)
    await expect(lease.release()).resolves.toBe(false)
    expect(fileSystem.unlink).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it.each([
    {
      name: 'birth time',
      original: { birthtimeMs: 5, mtimeMs: 1, size: 10 },
      current: { birthtimeMs: 5, mtimeMs: 2, size: 20 },
    },
    {
      name: 'modification time and size',
      original: { mtimeMs: 5, size: 10 },
      current: { mtimeMs: 5, size: 10 },
    },
  ])(
    'uses $name when device and inode identity are unavailable',
    async ({ current, original }) => {
      const close = vi.fn(async () => {})
      let exists = true
      const contents = JSON.stringify({
        schemaVersion: OWNED_FILE_LEASE_SCHEMA_VERSION,
        ownerToken: 'owner-token',
        pid: 12345,
        createdAt: 1,
        updatedAt: 1,
      })
      const fileSystem: FileSystemBoundary = {
        ...nodeFileSystem,
        readText: async () => {
          if (!exists) {
            throw new Error('missing')
          }
          return contents
        },
        stat: async () => {
          if (!exists) {
            throw new Error('missing')
          }
          return current
        },
        unlink: async () => {
          exists = false
        },
      }
      const lease = new OwnedFileLease({
        createdAt: 1,
        fileHandle: { close } as never,
        fileIdentity: original,
        filePath: 'lease.lock',
        fileSystem,
        ownerToken: 'owner-token',
        pid: 12345,
      })

      await expect(lease.isOwner()).resolves.toBe(true)
      await expect(lease.release()).resolves.toBe(true)
    },
  )

  it('keeps live current, future, and legacy owners despite old timestamps', async () => {
    const tempDir = await createTempDir(tempDirs)
    const clock = createClock(50_000)
    for (const [name, metadata] of [
      [
        'v1',
        {
          schemaVersion: 1,
          ownerToken: 'v1-owner',
          pid: 222,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      ['future', { schemaVersion: 2, ownerToken: 'future', pid: 222 }],
      ['legacy', { ownerId: 'legacy-owner', pid: 222, lastUpdatedAt: 1 }],
      ['pid-reuse', { pid: 222, startedAt: 1 }],
    ] as const) {
      const leasePath = path.join(tempDir, `${name}.lock`)
      await fs.writeFile(leasePath, JSON.stringify(metadata), 'utf8')
      await expect(
        cleanupStaleOwnedFileLease(
          { filePath: leasePath, invalidStaleMs: 100 },
          { clock, process: createProcess(333, (pid) => pid === 222) },
        ),
      ).resolves.toBe(false)
      await expect(fs.stat(leasePath)).resolves.toBeDefined()
    }
  })

  it('reclaims a valid lease immediately when its owner is dead', async () => {
    const leasePath = await createLeasePath(tempDirs)
    const onReclaimed = vi.fn(async () => {})
    await fs.writeFile(
      leasePath,
      JSON.stringify({
        schemaVersion: OWNED_FILE_LEASE_SCHEMA_VERSION,
        ownerToken: 'dead-owner',
        pid: 222,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
      'utf8',
    )

    await expect(
      cleanupStaleOwnedFileLease(
        { filePath: leasePath, invalidStaleMs: 10_000, onReclaimed },
        { process: createProcess(333, () => false) },
      ),
    ).resolves.toBe(true)
    expect(onReclaimed).toHaveBeenCalledWith(
      expect.objectContaining({ ownerToken: 'dead-owner', pid: 222 }),
    )
    await expect(fs.stat(leasePath)).rejects.toThrow()
  })

  it('treats an already missing lease and an unlink race as reclaimed', async () => {
    const missingFileSystem: FileSystemBoundary = {
      ...nodeFileSystem,
      readText: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
      stat: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
    }
    await expect(
      cleanupStaleOwnedFileLease(
        { filePath: 'missing.lock', invalidStaleMs: 100 },
        { fileSystem: missingFileSystem },
      ),
    ).resolves.toBe(true)

    const contents = JSON.stringify({ ownerId: 'dead', pid: 222 })
    let statCalls = 0
    const racedFileSystem: FileSystemBoundary = {
      ...nodeFileSystem,
      readText: async () => contents,
      stat: async () => {
        statCalls += 1
        if (statCalls === 3) {
          throw Object.assign(new Error('removed by another process'), {
            code: 'ENOENT',
          })
        }
        return { dev: 1, ino: 1, mtimeMs: 1, size: contents.length }
      },
      unlink: async () => {
        throw Object.assign(new Error('removed by another process'), {
          code: 'ENOENT',
        })
      },
    }
    await expect(
      cleanupStaleOwnedFileLease(
        { filePath: 'raced.lock', invalidStaleMs: 100 },
        {
          fileSystem: racedFileSystem,
          process: createProcess(333, () => false),
        },
      ),
    ).resolves.toBe(true)
  })

  it('does not claim an unreadable existing lease was reclaimed', async () => {
    const unlink = vi.fn(async () => {})
    const fileSystem: FileSystemBoundary = {
      ...nodeFileSystem,
      readText: async () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      },
      stat: async () => ({ dev: 1, ino: 1, mtimeMs: 1, size: 10 }),
      unlink,
    }

    await expect(
      cleanupStaleOwnedFileLease(
        { filePath: 'unreadable.lock', invalidStaleMs: 100 },
        { fileSystem },
      ),
    ).rejects.toMatchObject({
      name: 'OwnedFileLeaseOperationalError',
      operation: 'inspect existing lease metadata',
    })
    expect(unlink).not.toHaveBeenCalled()
  })

  it('does not claim a lease is missing when all metadata access is denied', async () => {
    const permissionError = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    })
    const fileSystem: FileSystemBoundary = {
      ...nodeFileSystem,
      readText: async () => {
        throw permissionError
      },
      stat: async () => {
        throw permissionError
      },
    }

    await expect(
      cleanupStaleOwnedFileLease(
        { filePath: 'inaccessible.lock', invalidStaleMs: 100 },
        { fileSystem },
      ),
    ).rejects.toMatchObject({
      name: 'OwnedFileLeaseOperationalError',
      operation: 'inspect existing lease metadata',
    })
  })

  it('applies the invalid-file grace period at its exact boundary', async () => {
    const leasePath = await createLeasePath(tempDirs)
    const clock = createClock(10_000)
    await fs.writeFile(leasePath, '{', 'utf8')
    await fs.utimes(leasePath, new Date(9_001), new Date(9_001))

    await expect(
      cleanupStaleOwnedFileLease(
        { filePath: leasePath, invalidStaleMs: 1_000 },
        { clock },
      ),
    ).resolves.toBe(false)
    await fs.utimes(leasePath, new Date(9_000), new Date(9_000))
    await expect(
      cleanupStaleOwnedFileLease(
        { filePath: leasePath, invalidStaleMs: 1_000 },
        { clock },
      ),
    ).resolves.toBe(true)
  })

  it('does not remove a lease replaced during stale-owner detection', async () => {
    const leasePath = await createLeasePath(tempDirs)
    await fs.writeFile(
      leasePath,
      JSON.stringify({ ownerId: 'old-owner', pid: 222, startedAt: 1 }),
      'utf8',
    )
    const replacement = JSON.stringify({
      ownerId: 'replacement-owner',
      pid: 333,
      startedAt: 2,
    })

    await expect(
      cleanupStaleOwnedFileLease(
        { filePath: leasePath, invalidStaleMs: 100 },
        {
          process: createProcess(444, () => {
            requireWrite(leasePath, replacement)
            return false
          }),
        },
      ),
    ).resolves.toBe(false)
    await expect(fs.readFile(leasePath, 'utf8')).resolves.toBe(replacement)
  })

  it('does not remove a path whose file identity changes during cleanup', async () => {
    const unlink = vi.fn(async () => {})
    const contents = JSON.stringify({ ownerId: 'old', pid: 222 })
    let statCount = 0
    const fileSystem: FileSystemBoundary = {
      ...nodeFileSystem,
      readText: async () => contents,
      stat: async () => {
        statCount += 1
        return { dev: 1, ino: statCount, mtimeMs: 1, size: 1 }
      },
      unlink,
    }

    await expect(
      cleanupStaleOwnedFileLease(
        { filePath: 'lease.lock', invalidStaleMs: 100 },
        { fileSystem, process: createProcess(333, () => false) },
      ),
    ).resolves.toBe(false)
    expect(unlink).not.toHaveBeenCalled()
  })

  it('discards a partial metadata write only when the candidate is unchanged', async () => {
    const close = vi.fn(async () => {})
    const unlink = vi.fn(async () => {})
    const fileHandle = {
      close,
      stat: async () => ({ dev: 1, ino: 1, mtimeMs: 1, size: 0 }),
      truncate: async () => {},
      write: async () => ({ bytesWritten: 0 }),
    }
    const fileSystem: FileSystemBoundary = {
      ...nodeFileSystem,
      openExclusive: async () => fileHandle as never,
      stat: async () => ({ dev: 1, ino: 1, mtimeMs: 1, size: 0 }),
      unlink,
    }

    await expect(
      tryAcquireOwnedFileLease(
        { filePath: 'lease.lock', invalidStaleMs: 100 },
        { fileSystem },
      ),
    ).rejects.toMatchObject({
      name: 'OwnedFileLeaseOperationalError',
      operation: 'write ownership metadata',
    })
    expect(close).toHaveBeenCalledOnce()
    expect(unlink).toHaveBeenCalledWith('lease.lock')
  })

  it('does not discard a failed candidate after its path identity changes', async () => {
    const close = vi.fn(async () => {})
    const unlink = vi.fn(async () => {})
    const fileHandle = {
      close,
      stat: async () => ({ dev: 1, ino: 1, mtimeMs: 1, size: 0 }),
      truncate: async () => {},
      write: async () => ({ bytesWritten: 0 }),
    }
    const fileSystem: FileSystemBoundary = {
      ...nodeFileSystem,
      openExclusive: async () => fileHandle as never,
      stat: async () => ({ dev: 1, ino: 2, mtimeMs: 1, size: 0 }),
      unlink,
    }

    await expect(
      tryAcquireOwnedFileLease(
        { filePath: 'lease.lock', invalidStaleMs: 100 },
        { fileSystem },
      ),
    ).rejects.toMatchObject({
      name: 'OwnedFileLeaseOperationalError',
      operation: 'write ownership metadata',
    })
    expect(close).toHaveBeenCalledOnce()
    expect(unlink).not.toHaveBeenCalled()
  })

  it('closes failed acquisitions and propagates unexpected open errors', async () => {
    const close = vi.fn(async () => {})
    const statFailureFileSystem: FileSystemBoundary = {
      ...nodeFileSystem,
      openExclusive: async () =>
        ({
          close,
          stat: async () => {
            throw new Error('stat failed')
          },
        }) as never,
    }
    await expect(
      tryAcquireOwnedFileLease(
        { filePath: 'lease.lock', invalidStaleMs: 100 },
        { fileSystem: statFailureFileSystem },
      ),
    ).rejects.toMatchObject({
      name: 'OwnedFileLeaseOperationalError',
      operation: 'inspect the exclusive lease candidate',
    })
    expect(close).toHaveBeenCalledOnce()

    const openError = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    })
    await expect(
      tryAcquireOwnedFileLease(
        { filePath: 'lease.lock', invalidStaleMs: 100 },
        {
          fileSystem: {
            ...nodeFileSystem,
            openExclusive: async () => {
              throw openError
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      cause: openError,
      name: 'OwnedFileLeaseOperationalError',
      operation: 'open an exclusive candidate',
    })
  })

  it('bounds a perpetual create/reclaim race to two exclusive opens', async () => {
    const openExclusive = vi.fn(async () => {
      throw Object.assign(new Error('exists'), { code: 'EEXIST' })
    })
    const missing = async (): Promise<never> => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    }
    await expect(
      tryAcquireOwnedFileLease(
        { filePath: 'race.lock', invalidStaleMs: 100 },
        {
          fileSystem: {
            ...nodeFileSystem,
            openExclusive,
            readText: missing,
            stat: missing,
          },
        },
      ),
    ).resolves.toBeUndefined()
    expect(openExclusive).toHaveBeenCalledTimes(2)
  })

  it.each(['write', 'post-write-stat'] as const)(
    'closes and cleans an unchanged candidate after %s failure',
    async (phase) => {
      const failure = Object.assign(new Error('storage failure'), {
        code: 'EIO',
      })
      const close = vi.fn(async () => {})
      const unlink = vi.fn(async () => {})
      const stat = vi.fn(async () => ({ dev: 1, ino: 1, mtimeMs: 1, size: 0 }))
      if (phase === 'post-write-stat') {
        stat.mockResolvedValueOnce({ dev: 1, ino: 1, mtimeMs: 1, size: 0 })
        stat.mockRejectedValueOnce(failure)
      }
      const fileHandle = {
        close,
        stat,
        truncate: async () => {},
        write: async (_buffer: Buffer, _offset: number, length: number) => {
          if (phase === 'write') {
            throw failure
          }
          return { bytesWritten: length }
        },
      }
      await expect(
        tryAcquireOwnedFileLease(
          { filePath: 'lease.lock', invalidStaleMs: 100 },
          {
            fileSystem: {
              ...nodeFileSystem,
              openExclusive: async () => fileHandle as never,
              stat: async () => ({ dev: 1, ino: 1, mtimeMs: 2, size: 100 }),
              unlink,
            },
          },
        ),
      ).rejects.toMatchObject({
        name: 'OwnedFileLeaseOperationalError',
        cause: failure,
      })
      expect(close).toHaveBeenCalledOnce()
      expect(unlink).toHaveBeenCalledWith('lease.lock')
    },
  )

  it('keeps ordinary live-owner contention to a single exclusive open', async () => {
    const leasePath = await createLeasePath(tempDirs)
    await fs.writeFile(leasePath, JSON.stringify({ pid: process.pid }))
    const openExclusive = vi.fn(nodeFileSystem.openExclusive)
    await expect(
      tryAcquireOwnedFileLease(
        { filePath: leasePath, invalidStaleMs: 0 },
        { fileSystem: { ...nodeFileSystem, openExclusive } },
      ),
    ).resolves.toBeUndefined()
    expect(openExclusive).toHaveBeenCalledOnce()
  })

  it('releases a newly written candidate when its ownership read fails', async () => {
    const leasePath = await createLeasePath(tempDirs)
    const failure = Object.assign(new Error('transient read error'), {
      code: 'EIO',
    })
    const readText = vi
      .fn(nodeFileSystem.readText)
      .mockRejectedValueOnce(failure)
    await expect(
      tryAcquireOwnedFileLease(
        { filePath: leasePath, invalidStaleMs: 100 },
        { fileSystem: { ...nodeFileSystem, readText } },
      ),
    ).rejects.toMatchObject({
      name: 'OwnedFileLeaseOperationalError',
      cause: failure,
    })
    await expect(fs.stat(leasePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('propagates a reclaim unlink failure and preserves the dead-owner file', async () => {
    const leasePath = await createLeasePath(tempDirs)
    await fs.writeFile(leasePath, JSON.stringify({ pid: 222 }))
    const failure = Object.assign(new Error('unlink denied'), {
      code: 'EACCES',
    })
    await expect(
      cleanupStaleOwnedFileLease(
        { filePath: leasePath, invalidStaleMs: 100 },
        {
          process: createProcess(333, () => false),
          fileSystem: {
            ...nodeFileSystem,
            unlink: async () => {
              throw failure
            },
          },
        },
      ),
    ).rejects.toMatchObject({
      name: 'OwnedFileLeaseOperationalError',
      operation: 'remove a reclaimable lease',
      cause: failure,
    })
    expect(readJson(await fs.readFile(leasePath, 'utf8'))).toEqual({ pid: 222 })
  })

  it.each([1, 2])(
    'closes without deleting when release ownership check %i cannot read metadata',
    async (failedCheck) => {
      const leasePath = await createLeasePath(tempDirs)
      const readText = vi.fn(nodeFileSystem.readText)
      const lease = await tryAcquireOwnedFileLease(
        { filePath: leasePath, invalidStaleMs: 100 },
        { fileSystem: { ...nodeFileSystem, readText } },
      )
      if (failedCheck === 2) {
        readText.mockImplementationOnce(nodeFileSystem.readText)
      }
      readText.mockRejectedValueOnce(
        Object.assign(new Error('read denied'), { code: 'EACCES' }),
      )
      await expect(lease?.release()).resolves.toBe(false)
      await expect(lease?.isOwner()).resolves.toBe(false)
      await expect(fs.readFile(leasePath, 'utf8')).resolves.toContain(
        lease?.ownerToken,
      )
    },
  )

  it('yields when a reclaimable file disappears during the final recheck', async () => {
    const leasePath = await createLeasePath(tempDirs)
    await fs.writeFile(leasePath, JSON.stringify({ pid: 222 }))
    const readText = vi.fn(nodeFileSystem.readText)
    readText.mockImplementationOnce(async (filePath) => {
      const contents = await nodeFileSystem.readText(filePath)
      await fs.unlink(filePath)
      return contents
    })
    await expect(
      cleanupStaleOwnedFileLease(
        { filePath: leasePath, invalidStaleMs: 100 },
        {
          process: createProcess(333, () => false),
          fileSystem: { ...nodeFileSystem, readText },
        },
      ),
    ).resolves.toBe(true)
  })

  it('does not publish an acquisition whose ownership changed after writing', async () => {
    const close = vi.fn(async () => {})
    const unlink = vi.fn(async () => {})
    const fileHandle = {
      close,
      stat: async () => ({ dev: 1, ino: 1, mtimeMs: 1, size: 0 }),
      truncate: async () => {},
      write: async (_buffer: Buffer, _offset: number, length: number) => ({
        bytesWritten: length,
      }),
    }
    const replacement = JSON.stringify({
      schemaVersion: OWNED_FILE_LEASE_SCHEMA_VERSION,
      ownerToken: 'replacement',
      pid: 222,
      createdAt: 1,
      updatedAt: 1,
    })
    const fileSystem: FileSystemBoundary = {
      ...nodeFileSystem,
      openExclusive: async () => fileHandle as never,
      readText: async () => replacement,
      stat: async () => ({ dev: 1, ino: 1, mtimeMs: 1, size: 0 }),
      unlink,
    }

    await expect(
      tryAcquireOwnedFileLease(
        { filePath: 'lease.lock', invalidStaleMs: 100 },
        { fileSystem, randomId: () => 'original' },
      ),
    ).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledOnce()
    expect(unlink).not.toHaveBeenCalled()
  })

  it('settles release safely when unlinking the owned path fails', async () => {
    const contents = JSON.stringify({
      schemaVersion: OWNED_FILE_LEASE_SCHEMA_VERSION,
      ownerToken: 'owner-token',
      pid: 12345,
      createdAt: 1,
      updatedAt: 1,
    })
    const fileSystem: FileSystemBoundary = {
      ...nodeFileSystem,
      readText: async () => contents,
      stat: async () => ({ dev: 1, ino: 1, mtimeMs: 1, size: 1 }),
      unlink: async () => {
        throw new Error('busy')
      },
    }
    const lease = new OwnedFileLease({
      createdAt: 1,
      fileHandle: { close: async () => {} } as never,
      fileIdentity: { dev: 1, ino: 1, mtimeMs: 1, size: 1 },
      filePath: 'lease.lock',
      fileSystem,
      ownerToken: 'owner-token',
      pid: 12345,
    })

    await expect(lease.release()).resolves.toBe(false)
  })

  it('parses only complete v1 metadata while recognizing legacy PID locks', () => {
    expect(
      parseOwnedFileLeaseMetadata(
        JSON.stringify({
          schemaVersion: OWNED_FILE_LEASE_SCHEMA_VERSION,
          ownerToken: 'owner',
          pid: 12,
          createdAt: 1,
          updatedAt: 2,
          payload: { value: true },
        }),
      ),
    ).toMatchObject({
      format: 'v1',
      ownerToken: 'owner',
      pid: 12,
      payload: { value: true },
    })
    expect(
      parseOwnedFileLeaseMetadata(
        JSON.stringify({ pid: 12, startedAt: 1, lastUpdatedAt: 2 }),
      ),
    ).toMatchObject({ format: 'legacy', pid: 12, updatedAt: 2 })
    expect(
      parseOwnedFileLeaseMetadata(
        JSON.stringify({
          schemaVersion: 2,
          ownerToken: 'owner',
          pid: 12,
          createdAt: 1,
          updatedAt: 2,
        }),
      ),
    ).toMatchObject({ format: 'future', ownerToken: 'owner', pid: 12 })
    expect(parseOwnedFileLeaseMetadata(JSON.stringify([]))).toBeUndefined()
    expect(
      parseOwnedFileLeaseMetadata(JSON.stringify({ pid: 0 })),
    ).toBeUndefined()
    expect(parseOwnedFileLeaseMetadata('{')).toBeUndefined()
    expect(
      parseOwnedFileLeaseMetadata(JSON.stringify({ schemaVersion: 2, pid: 0 })),
    ).toBeUndefined()
    expect(
      parseOwnedFileLeaseMetadata(
        JSON.stringify({ schemaVersion: 1, pid: 12 }),
      ),
    ).toBeUndefined()
  })

  it('coordinates processes and recovers a lease after its owner is killed', async () => {
    const leasePath = await createLeasePath(tempDirs)
    const holder = await startHoldingLease(leasePath)
    try {
      await expect(runLeaseChild(leasePath, 'release')).resolves.toBe('BLOCKED')
    } finally {
      await terminateChild(holder)
    }

    await expect(runLeaseChild(leasePath, 'release')).resolves.toBe('ACQUIRED')
    await expect(fs.stat(leasePath)).rejects.toThrow()
  })
})

const createTempDir = async (tempDirs: string[]): Promise<string> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-owned-lease-'))
  tempDirs.push(tempDir)
  return tempDir
}

const createLeasePath = async (tempDirs: string[]): Promise<string> => {
  return path.join(await createTempDir(tempDirs), 'lease.lock')
}

const readJson = (contents: string): Record<string, unknown> => {
  return JSON.parse(contents) as Record<string, unknown>
}

const requireWrite = (filePath: string, contents: string): void => {
  writeFileSync(filePath, contents, 'utf8')
}

const runLeaseChild = (
  leasePath: string,
  mode: 'hold' | 'release',
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const child = spawnLeaseChild(leasePath, mode)
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
        resolve(stdout.trim())
        return
      }
      reject(new Error(`Lease child exited with ${String(code)}: ${stderr}`))
    })
  })
}

const startHoldingLease = (leasePath: string): Promise<ChildProcess> => {
  return new Promise((resolve, reject) => {
    const child = spawnLeaseChild(leasePath, 'hold')
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Timed out waiting for lease holder: ${stderr}`))
    }, 10_000)
    timeout.unref?.()
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      if (!chunk.toString('utf8').includes('ACQUIRED')) {
        return
      }
      clearTimeout(timeout)
      resolve(child)
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      reject(
        new Error(`Lease holder exited early with ${String(code)}: ${stderr}`),
      )
    })
  })
}

const terminateChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  await new Promise<void>((resolve) => {
    child.once('close', () => resolve())
    child.kill('SIGKILL')
  })
}

const spawnLeaseChild = (
  leasePath: string,
  mode: 'hold' | 'release',
): ChildProcess => {
  return spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      path.resolve('tests/scripts/owned-file-lease-child.ts'),
      leasePath,
      mode,
    ],
    { windowsHide: true },
  )
}
