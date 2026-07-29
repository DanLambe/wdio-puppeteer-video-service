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
  OWNED_FILE_LEASE_SCHEMA_VERSION,
  OwnedFileLease,
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
  runInterval(): void
  setNow(value: number): void
} => {
  let now = initialNow
  let intervalCallback: (() => void) | undefined
  return {
    clearInterval: vi.fn(),
    clearTimeout: vi.fn(),
    delay: async (milliseconds) => {
      now += milliseconds
    },
    now: () => now,
    queueMicrotask,
    runInterval(): void {
      intervalCallback?.()
    },
    setInterval: vi.fn((callback) => {
      intervalCallback = callback
      return { unref: vi.fn() } as unknown as NodeJS.Timeout
    }),
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

  it('writes versioned ownership metadata and releases idempotently', async () => {
    const leasePath = await createLeasePath(tempDirs)
    const clock = createClock(100)
    const lease = await tryAcquireOwnedFileLease(
      {
        filePath: leasePath,
        heartbeatIntervalMs: 25,
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
    expect(clock.setInterval).toHaveBeenCalledWith(expect.any(Function), 25)

    await expect(lease?.release()).resolves.toBe(true)
    await expect(lease?.release()).resolves.toBe(true)
    expect(clock.clearInterval).toHaveBeenCalledOnce()
    await expect(fs.stat(leasePath)).rejects.toThrow()
  })

  it('refreshes timestamps without changing identity or creation time', async () => {
    const leasePath = await createLeasePath(tempDirs)
    const clock = createClock(100)
    const lease = await tryAcquireOwnedFileLease(
      { filePath: leasePath, invalidStaleMs: 100 },
      { clock, process: createProcess() },
    )
    clock.setNow(250)

    await expect(lease?.refresh()).resolves.toBe(true)
    expect(readJson(await fs.readFile(leasePath, 'utf8'))).toMatchObject({
      ownerToken: lease?.ownerToken,
      createdAt: 100,
      updatedAt: 250,
    })
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

  it('runs heartbeat refreshes and becomes inactive after release', async () => {
    const leasePath = await createLeasePath(tempDirs)
    const clock = createClock(100)
    const lease = await tryAcquireOwnedFileLease(
      {
        filePath: leasePath,
        heartbeatIntervalMs: 25,
        invalidStaleMs: 100,
      },
      { clock, process: createProcess() },
    )

    expect(lease?.active).toBe(true)
    clock.setNow(250)
    clock.runInterval()
    await vi.waitFor(async () => {
      expect(readJson(await fs.readFile(leasePath, 'utf8'))).toMatchObject({
        updatedAt: 250,
      })
    })

    await expect(lease?.release()).resolves.toBe(true)
    expect(lease?.active).toBe(false)
    await expect(lease?.refresh()).resolves.toBe(false)
    lease?.startHeartbeat(25)
    expect(clock.setInterval).toHaveBeenCalledOnce()
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

    await expect(lease?.refresh()).resolves.toBe(false)
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
      clock: createClock(),
      createdAt: 1,
      fileHandle: { close } as never,
      fileIdentity: { dev: 1, ino: 1, mtimeMs: 1, size: 1 },
      filePath: 'lease.lock',
      fileSystem,
      ownerToken: 'owner-token',
      payload: undefined,
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
        clock: createClock(),
        createdAt: 1,
        fileHandle: { close } as never,
        fileIdentity: original,
        filePath: 'lease.lock',
        fileSystem,
        ownerToken: 'owner-token',
        payload: undefined,
        pid: 12345,
      })

      await expect(lease.isOwner()).resolves.toBe(true)
      await expect(lease.release()).resolves.toBe(true)
    },
  )

  it('keeps live v1 and legacy owners despite expired heartbeats', async () => {
    const tempDir = await createTempDir(tempDirs)
    const clock = createClock(50_000)
    for (const [name, metadata] of [
      [
        'v1',
        {
          schemaVersion: OWNED_FILE_LEASE_SCHEMA_VERSION,
          ownerToken: 'v1-owner',
          pid: 222,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
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
        throw new Error('missing')
      },
      stat: async () => {
        throw new Error('missing')
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
          throw new Error('removed by another process')
        }
        return { dev: 1, ino: 1, mtimeMs: 1, size: contents.length }
      },
      unlink: async () => {
        throw new Error('removed by another process')
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
    ).resolves.toBeUndefined()
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
    ).resolves.toBeUndefined()
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
    ).resolves.toBeUndefined()
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
    ).rejects.toBe(openError)
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
      clock: createClock(),
      createdAt: 1,
      fileHandle: { close: async () => {} } as never,
      fileIdentity: { dev: 1, ino: 1, mtimeMs: 1, size: 1 },
      filePath: 'lease.lock',
      fileSystem,
      ownerToken: 'owner-token',
      payload: undefined,
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
    ).toBeUndefined()
    expect(parseOwnedFileLeaseMetadata(JSON.stringify([]))).toBeUndefined()
    expect(
      parseOwnedFileLeaseMetadata(JSON.stringify({ pid: 0 })),
    ).toBeUndefined()
    expect(parseOwnedFileLeaseMetadata('{')).toBeUndefined()
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
