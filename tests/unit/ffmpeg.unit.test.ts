import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type FfmpegVersionProbe,
  getFfmpegCandidates,
  probeDirectMp4Support,
  probeFfmpegVersion,
  readFfmpegVersion,
  resolveFfmpeg,
  resolveOptionalFfmpegStaticPath,
} from '../../src/service/ffmpeg.js'

class FakeProbeProcess extends EventEmitter {
  stderr: PassThrough | null = new PassThrough()
  stdout: PassThrough | null = new PassThrough()
  kill = vi.fn(() => true)
}

describe('ffmpeg helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('deduplicates ffmpeg candidates while preserving priority order', () => {
    const candidates = getFfmpegCandidates(
      '  /custom/ffmpeg  ',
      ' /env/ffmpeg ',
    )

    expect(candidates[0]).toBe('/custom/ffmpeg')
    expect(candidates[1]).toBe('/env/ffmpeg')
    expect(candidates).toContain('ffmpeg')
    expect(new Set(candidates).size).toBe(candidates.length)
  })

  it('returns the first candidate that runs, with its version, probing each once', async () => {
    const probe = vi.fn(
      async (candidate: string): Promise<FfmpegVersionProbe> =>
        candidate === '/second/ffmpeg'
          ? { ran: true, version: '7.1' }
          : { ran: false, version: undefined },
    )

    const resolved = await resolveFfmpeg(
      ['/first/ffmpeg', '/second/ffmpeg', '/third/ffmpeg'],
      probe,
    )

    expect(resolved).toEqual({ path: '/second/ffmpeg', version: '7.1' })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(probe).toHaveBeenNthCalledWith(1, '/first/ffmpeg')
    expect(probe).toHaveBeenNthCalledWith(2, '/second/ffmpeg')
  })

  it('accepts a candidate that runs but reports no recognizable version', async () => {
    await expect(
      resolveFfmpeg(['/custom/ffmpeg'], async () => ({
        ran: true,
        version: undefined,
      })),
    ).resolves.toEqual({ path: '/custom/ffmpeg', version: undefined })
  })

  it('returns undefined when no ffmpeg candidate runs', async () => {
    const resolved = await resolveFfmpeg(
      ['/first/ffmpeg', '/second/ffmpeg'],
      async () => ({ ran: false, version: undefined }),
    )

    expect(resolved).toBeUndefined()
  })

  it('uses the real version probe when none is supplied', async () => {
    await expect(resolveFfmpeg([process.execPath])).resolves.toBeUndefined()
  })

  it('learns availability and version from one -version spawn', async () => {
    const probeProcess = new FakeProbeProcess()
    const spawnProcess = vi.fn(
      (_command: string, _args: string[]) => probeProcess,
    )
    const probeTask = probeFfmpegVersion('/custom/ffmpeg', spawnProcess)
    probeProcess.stdout?.write('ffmpeg version n7.1-12 Copyright\n')
    probeProcess.emit('close', 0)

    await expect(probeTask).resolves.toEqual({ ran: true, version: 'n7.1-12' })
    expect(spawnProcess).toHaveBeenCalledOnce()
    expect(spawnProcess).toHaveBeenCalledWith('/custom/ffmpeg', ['-version'])
  })

  it('treats a clean exit without a version line as a runnable binary', async () => {
    const probeProcess = new FakeProbeProcess()
    const probeTask = probeFfmpegVersion('ffmpeg', () => probeProcess)
    probeProcess.stdout?.write('custom build\n')
    probeProcess.emit('close', 0)

    await expect(probeTask).resolves.toEqual({ ran: true, version: undefined })
  })

  it('reports a failed, errored, or timed-out probe as not runnable', async () => {
    const failedProcess = new FakeProbeProcess()
    const failedTask = probeFfmpegVersion('ffmpeg', () => failedProcess)
    failedProcess.emit('close', 1)
    await expect(failedTask).resolves.toEqual({
      ran: false,
      version: undefined,
    })

    const erroredProcess = new FakeProbeProcess()
    const erroredTask = probeFfmpegVersion('ffmpeg', () => erroredProcess)
    erroredProcess.emit('error', new Error('spawn ENOENT'))
    await expect(erroredTask).resolves.toEqual({
      ran: false,
      version: undefined,
    })

    vi.useFakeTimers()
    const timedOutProcess = new FakeProbeProcess()
    const timedOutTask = probeFfmpegVersion('ffmpeg', () => timedOutProcess)
    await vi.runAllTimersAsync()
    await expect(timedOutTask).resolves.toEqual({
      ran: false,
      version: undefined,
    })
    expect(timedOutProcess.kill).toHaveBeenCalled()
  })

  it('reads the FFmpeg version from its first output line', async () => {
    const probeProcess = new FakeProbeProcess()
    const versionTask = readFfmpegVersion('ffmpeg', () => probeProcess)
    probeProcess.stdout?.write('ffmpeg version 7.1.1 Copyright\nconfiguration')
    probeProcess.emit('close', 0)
    await expect(versionTask).resolves.toBe('7.1.1')
  })

  it('returns no FFmpeg version for failures, errors, and timeouts', async () => {
    const failedProcess = new FakeProbeProcess()
    const failedTask = readFfmpegVersion('ffmpeg', () => failedProcess)
    failedProcess.emit('close', 1)
    await expect(failedTask).resolves.toBeUndefined()

    const erroredProcess = new FakeProbeProcess()
    const erroredTask = readFfmpegVersion('ffmpeg', () => erroredProcess)
    erroredProcess.emit('error', new Error('spawn failed'))
    await expect(erroredTask).resolves.toBeUndefined()

    vi.useFakeTimers()
    const timedOutProcess = new FakeProbeProcess()
    const timedOutTask = readFfmpegVersion('ffmpeg', () => timedOutProcess)
    await vi.runAllTimersAsync()
    await expect(timedOutTask).resolves.toBeUndefined()
    expect(timedOutProcess.kill).toHaveBeenCalled()
  })

  it('uses the production spawn boundary when no version probe is injected', async () => {
    await expect(readFfmpegVersion(process.execPath)).resolves.toBeUndefined()
  })

  it('reports direct MP4 support when the probe exits cleanly', async () => {
    const probeProcess = new FakeProbeProcess()
    let seenArgs: string[] | undefined
    const supportPromise = probeDirectMp4Support('/custom/ffmpeg', {
      spawnProcess: (_ffmpegPath, args) => {
        seenArgs = args
        return probeProcess
      },
    })

    probeProcess.emit('close', 0)

    await expect(supportPromise).resolves.toBe(true)
    expect(probeProcess.kill).not.toHaveBeenCalled()
    expect(seenArgs).toEqual(
      expect.arrayContaining([
        '-vcodec',
        'vp9',
        '-movflags',
        'hybrid_fragmented',
        '-f',
        'mp4',
      ]),
    )
    expect(seenArgs).not.toContain('mpeg4')
  })

  it('logs probe failure details when direct MP4 support is unavailable', async () => {
    const probeProcess = new FakeProbeProcess()
    const onProbeFailure = vi.fn()
    const supportPromise = probeDirectMp4Support('/custom/ffmpeg', {
      onProbeFailure,
      spawnProcess: () => probeProcess,
    })

    probeProcess.stderr?.write('muxer failed')
    probeProcess.emit('close', 1)

    await expect(supportPromise).resolves.toBe(false)
    expect(onProbeFailure).toHaveBeenCalledWith('muxer failed')
  })

  it('preserves UTF-8 characters split across probe stderr chunks', async () => {
    const probeProcess = new FakeProbeProcess()
    const onProbeFailure = vi.fn()
    const diagnostic = Buffer.from('muxer 🚨 failed')
    const marker = diagnostic.indexOf(Buffer.from('🚨'))
    const supportPromise = probeDirectMp4Support('/custom/ffmpeg', {
      onProbeFailure,
      spawnProcess: () => probeProcess,
    })

    probeProcess.stderr?.write(diagnostic.subarray(0, marker + 2))
    probeProcess.stderr?.write(diagnostic.subarray(marker + 2))
    probeProcess.emit('close', 1)

    await expect(supportPromise).resolves.toBe(false)
    expect(onProbeFailure).toHaveBeenCalledWith('muxer 🚨 failed')
  })

  it('fails the direct MP4 probe when it times out', async () => {
    vi.useFakeTimers()
    try {
      const probeProcess = new FakeProbeProcess()
      const supportPromise = probeDirectMp4Support('/custom/ffmpeg', {
        spawnProcess: () => probeProcess,
      })

      await vi.runAllTimersAsync()

      await expect(supportPromise).resolves.toBe(false)
      expect(probeProcess.kill).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails the direct MP4 probe when the probe process emits an error', async () => {
    const probeProcess = new FakeProbeProcess()
    const onProbeFailure = vi.fn()
    const supportPromise = probeDirectMp4Support('/custom/ffmpeg', {
      onProbeFailure,
      spawnProcess: () => probeProcess,
    })

    probeProcess.emit('error', new Error('spawn failed'))

    await expect(supportPromise).resolves.toBe(false)
    expect(onProbeFailure).not.toHaveBeenCalled()
  })

  it('does not report probe failure details when stderr is empty', async () => {
    const probeProcess = new FakeProbeProcess()
    const onProbeFailure = vi.fn()
    const supportPromise = probeDirectMp4Support('/custom/ffmpeg', {
      onProbeFailure,
      spawnProcess: () => probeProcess,
    })

    probeProcess.emit('close', 1)

    await expect(supportPromise).resolves.toBe(false)
    expect(onProbeFailure).not.toHaveBeenCalled()
  })

  it('caps captured probe stderr to the final 8192 characters', async () => {
    const probeProcess = new FakeProbeProcess()
    const onProbeFailure = vi.fn()
    const supportPromise = probeDirectMp4Support('/custom/ffmpeg', {
      onProbeFailure,
      spawnProcess: () => probeProcess,
    })

    probeProcess.stderr?.write('a'.repeat(9000))
    probeProcess.emit('close', 1)

    await expect(supportPromise).resolves.toBe(false)
    expect(onProbeFailure).toHaveBeenCalledTimes(1)
    expect(onProbeFailure.mock.calls[0]?.[0]).toHaveLength(8192)
  })

  it('handles probe processes without a stderr stream', async () => {
    const probeProcess = new FakeProbeProcess()
    probeProcess.stderr = null

    const supportPromise = probeDirectMp4Support('/custom/ffmpeg', {
      spawnProcess: () => probeProcess,
    })

    probeProcess.emit('close', 1)

    await expect(supportPromise).resolves.toBe(false)
  })
})

// pnpm with an isolated or global store, and Yarn Plug'n'Play, resolve a
// package only from a project that declares it, so a consumer's own
// `ffmpeg-static` is not visible from this package's directory.
describe('ffmpeg-static resolution', () => {
  const createProject = async (binary: string): Promise<string> => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ffmpeg-static-'))
    const packageDir = path.join(project, 'node_modules', 'ffmpeg-static')
    await fs.mkdir(packageDir, { recursive: true })
    await fs.writeFile(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: 'ffmpeg-static', main: 'index.js' }),
    )
    await fs.writeFile(
      path.join(packageDir, 'index.js'),
      `module.exports = ${JSON.stringify(binary)}\n`,
    )
    await fs.writeFile(path.join(project, 'package.json'), '{}')
    return project
  }
  const notFound = (): never => {
    throw Object.assign(new Error('Cannot find module'), {
      code: 'MODULE_NOT_FOUND',
    })
  }

  it("falls back to the consuming project's own installation", async () => {
    const project = await createProject('/opt/project/ffmpeg')
    try {
      expect(
        resolveOptionalFfmpegStaticPath({
          cwd: project,
          requireFromPackage: notFound,
        }),
      ).toBe('/opt/project/ffmpeg')
    } finally {
      await fs.rm(project, { recursive: true, force: true })
    }
  })

  it('prefers the installation this package resolves', async () => {
    const project = await createProject('/opt/project/ffmpeg')
    try {
      expect(
        resolveOptionalFfmpegStaticPath({
          cwd: project,
          requireFromPackage: () => '/opt/package/ffmpeg',
        }),
      ).toBe('/opt/package/ffmpeg')
    } finally {
      await fs.rm(project, { recursive: true, force: true })
    }
  })

  it('finds nothing when neither has it', async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'no-ffmpeg-'))
    try {
      expect(
        resolveOptionalFfmpegStaticPath({
          cwd: project,
          requireFromPackage: notFound,
        }),
      ).toBeUndefined()
    } finally {
      await fs.rm(project, { recursive: true, force: true })
    }
  })

  it('ignores an installation without a binary for this platform', () => {
    expect(
      resolveOptionalFfmpegStaticPath({
        cwd: os.tmpdir(),
        requireFromPackage: () => null,
      }),
    ).toBeUndefined()
  })
})
