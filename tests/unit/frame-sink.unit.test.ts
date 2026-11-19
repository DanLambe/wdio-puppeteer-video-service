import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ClockBoundary } from '../../src/service/boundaries.js'
import {
  EncoderSink,
  type ScreencastSpool,
  type SpoolFileStream,
  SpoolSink,
} from '../../src/service/frame-sink.js'

const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve))

const settings: ScreencastSpool['settings'] = {
  canvas: { width: 320, height: 240 },
  format: 'webm',
  quality: 30,
  scale: 1,
}

// FFmpeg as the encoder sink sees it: stdin, stderr and its exit.
const createChild = (highWaterMark = 1) => {
  const chunks: Buffer[] = []
  const waiting: Array<() => void> = []
  let flowing = true
  const child = new EventEmitter() as ChildProcess & {
    exitCode: number | null
    signalCode: NodeJS.Signals | null
  }
  const stdin = new Writable({
    highWaterMark,
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      if (flowing) {
        callback()
      } else {
        waiting.push(callback)
      }
    },
  })
  const exit = (code: number | null, signal: NodeJS.Signals | null = null) => {
    Object.assign(child, { exitCode: code, signalCode: signal })
    child.emit('exit', code, signal)
    child.emit('close', code, signal)
  }
  stdin.on('finish', () => {
    setImmediate(() => exit(child.exitCode ?? 0))
  })
  Object.assign(child, {
    exitCode: null,
    kill: vi.fn(() => {
      setImmediate(() => exit(null, 'SIGKILL'))
      return true
    }),
    signalCode: null,
    stderr: new PassThrough(),
    stdin,
    stdout: null,
    unref: vi.fn(),
  })
  return {
    bytes: () => Buffer.concat(chunks),
    child,
    exit,
    stall: () => {
      flowing = false
    },
    release: () => {
      flowing = true
      for (const callback of waiting.splice(0)) {
        callback()
      }
    },
  }
}

describe('encoder sink', () => {
  it('hands bytes to FFmpeg and reports its backpressure and drain', async () => {
    const fake = createChild()
    const sink = new EncoderSink(fake.child)
    queueMicrotask(() => fake.child.emit('spawn'))
    await sink.ready
    fake.stall()

    expect(sink.writable).toBe(true)
    expect(sink.write(Buffer.from('ab'))).toBe(false)
    let drained = false
    const draining = sink.waitForDrain().then(() => {
      drained = true
    })
    await settle()
    expect(drained).toBe(false)
    fake.release()
    await draining
    expect(fake.bytes().toString()).toBe('ab')
    expect(sink.failure).toBeUndefined()
  })

  it('ends the input and waits for FFmpeg to close, leaving its exit to the result', async () => {
    const fake = createChild()
    const sink = new EncoderSink(fake.child)
    fake.child.stdin?.once('finish', () => {
      Object.assign(fake.child, { exitCode: 1 })
    })

    await sink.end()

    expect(sink.writable).toBe(false)
    expect(sink.write(Buffer.from('late'))).toBe(false)
    expect(sink.result.code).toBe(1)
    // An exit after the input ended is the encode's result, not a lost input.
    expect(sink.failure).toBeUndefined()
  })

  it('reports an encoder that exits before its input ends', async () => {
    const fake = createChild()
    const sink = new EncoderSink(fake.child)
    fake.child.stderr?.emit('data', Buffer.from('Invalid PNG signature\n'))
    fake.child.stdin?.destroy()
    fake.exit(1)
    await sink.closed

    expect(sink.writable).toBe(false)
    expect(sink.failure).toBe(
      'FFmpeg exited with code 1 before the recording was stopped: Invalid PNG signature',
    )
  })

  it('stops waiting for drain once the encoder closes', async () => {
    const fake = createChild()
    const sink = new EncoderSink(fake.child)
    fake.stall()
    sink.write(Buffer.from('ab'))
    const draining = sink.waitForDrain()
    fake.exit(null, 'SIGSEGV')
    await draining
    expect(sink.failure).toBe(
      'FFmpeg was terminated by SIGSEGV before the recording was stopped.',
    )
  })

  it('terminates FFmpeg on abort and never reports that as a failure', async () => {
    const fake = createChild()
    const terminateProcessTree = vi.fn(async () => {
      fake.child.kill('SIGKILL')
    })
    const sink = new EncoderSink(fake.child, { terminateProcessTree })

    await sink.abort()

    expect(terminateProcessTree).toHaveBeenCalledOnce()
    expect(sink.writable).toBe(false)
    expect(sink.failure).toBeUndefined()
  })

  it('reports a spawn failure to startup', async () => {
    const fake = createChild()
    const sink = new EncoderSink(fake.child, {}, true)
    fake.child.emit('error', new Error('spawn ffmpeg ENOENT'))
    await expect(sink.failed).resolves.toMatchObject({
      message: 'spawn ffmpeg ENOENT',
    })
    expect(() => sink.throwIfFailed()).toThrow('ENOENT')
  })

  it('takes no bytes without an input stream', async () => {
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { exitCode: null, signalCode: null, stdin: null })
    const sink = new EncoderSink(child)
    expect(sink.writable).toBe(false)
    expect(sink.write(Buffer.from('x'))).toBe(false)
    await expect(sink.waitForDrain()).resolves.toBeUndefined()
  })
})

// A spool file whose writes the test controls.
const createFakeFile = (
  options: { error?: NodeJS.ErrnoException; highWaterMark?: number } = {},
) => {
  const chunks: Buffer[] = []
  const waiting: Array<() => void> = []
  let flowing = true
  let written = 0
  const stream = new Writable({
    highWaterMark: options.highWaterMark ?? 4,
    write(chunk: Buffer, _encoding, callback) {
      if (options.error) {
        callback(options.error)
        return
      }
      const accept = (): void => {
        chunks.push(Buffer.from(chunk))
        written += chunk.length
        callback()
      }
      if (flowing) {
        accept()
      } else {
        waiting.push(accept)
      }
    },
  }) as SpoolFileStream
  Object.defineProperty(stream, 'bytesWritten', { get: () => written })
  return {
    bytes: () => Buffer.concat(chunks),
    open: vi.fn((_path: string) => stream),
    release: () => {
      flowing = true
      for (const accept of waiting.splice(0)) {
        accept()
      }
    },
    stall: () => {
      flowing = false
    },
    stream,
  }
}

const enospc = (): NodeJS.ErrnoException =>
  Object.assign(new Error('ENOSPC: no space left on device, write'), {
    code: 'ENOSPC',
  })

let directory = ''

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-sink-'))
})

afterAll(async () => {
  await fs.rm(directory, { recursive: true, force: true })
})

describe('spool sink', () => {
  it('writes a new file and counts the bytes it flushed', async () => {
    const spoolPath = path.join(directory, 'written.mkv')
    const sink = new SpoolSink({ path: spoolPath, settings })
    await sink.ready
    expect(sink.writable).toBe(true)
    sink.write(Buffer.from('header'))
    sink.write(Buffer.from('-block'))
    expect(sink.bytesWritten + sink.bytesBuffered).toBe(12)
    expect(sink.bytesAccepted).toBe(12)

    await sink.end()

    expect(await fs.readFile(spoolPath, 'utf8')).toBe('header-block')
    expect(sink.bytesWritten).toBe(12)
    expect(sink.bytesBuffered).toBe(0)
    expect(sink.writable).toBe(false)
    expect(sink.write(Buffer.from('late'))).toBe(false)
    expect(sink.failure).toBeUndefined()
    expect(sink.spool).toEqual({ path: spoolPath, settings })
  })

  it('never replaces a file already at its path', async () => {
    const spoolPath = path.join(directory, 'taken.mkv')
    await fs.writeFile(spoolPath, 'someone else')
    const sink = new SpoolSink({ path: spoolPath, settings })

    const error = await sink.failed
    expect(error.message).toMatch(
      /^The frame spool could not be written: EEXIST/u,
    )
    expect(() => sink.throwIfFailed()).toThrow(error)
    await sink.closed
    expect(await fs.readFile(spoolPath, 'utf8')).toBe('someone else')
  })

  it('reports backpressure, counts buffered bytes and resolves on drain', async () => {
    const file = createFakeFile()
    const sink = new SpoolSink(
      { path: 'spool.mkv', settings },
      { openFile: file.open },
    )
    await sink.ready
    file.stall()

    expect(sink.write(Buffer.from('abcdef'))).toBe(false)
    expect(sink.write(Buffer.from('gh'))).toBe(false)
    expect(sink.bytesBuffered).toBe(8)
    expect(sink.bytesWritten).toBe(0)
    let drained = false
    const draining = sink.waitForDrain().then(() => {
      drained = true
    })
    await settle()
    expect(drained).toBe(false)

    file.release()
    await draining
    expect(sink.bytesBuffered).toBe(0)
    expect(sink.bytesWritten).toBe(8)
    expect(file.open).toHaveBeenCalledExactlyOnceWith('spool.mkv')
  })

  it('reports a write error with its text and takes nothing more', async () => {
    const file = createFakeFile({ error: enospc() })
    const sink = new SpoolSink(
      { path: 'spool.mkv', settings },
      { openFile: file.open },
    )

    sink.write(Buffer.from('block'))
    await sink.waitForDrain()
    await sink.closed

    expect(sink.failure).toBe(
      'The frame spool could not be written: ENOSPC: no space left on device, write',
    )
    await expect(sink.failed).resolves.toMatchObject({
      cause: { code: 'ENOSPC' },
    })
    expect(sink.writable).toBe(false)
    expect(sink.write(Buffer.from('more'))).toBe(false)
    // Ending a failed spool settles, and leaves the failure in place.
    await expect(sink.end()).resolves.toBeUndefined()
    expect(sink.failure).toMatch(/ENOSPC/u)
  })

  it('reports a flush that fails while ending', async () => {
    const file = createFakeFile()
    Object.assign(file.stream, {
      _final: (callback: (error?: Error) => void) => {
        callback(enospc())
      },
    })
    const sink = new SpoolSink(
      { path: 'spool.mkv', settings },
      { openFile: file.open },
    )
    sink.write(Buffer.from('block'))

    await sink.end()

    expect(sink.failure).toMatch(/ENOSPC/u)
  })

  it('closes the file on abort so the caller can delete it', async () => {
    const spoolPath = path.join(directory, 'aborted.mkv')
    const sink = new SpoolSink({ path: spoolPath, settings })
    await sink.ready
    sink.write(Buffer.from('header'))

    const aborting = sink.abort()
    expect(sink.abort()).toBe(aborting)
    await aborting

    expect(sink.writable).toBe(false)
    expect(sink.write(Buffer.from('late'))).toBe(false)
    expect(sink.failure).toBeUndefined()
    // Closed: deleting it succeeds on every platform.
    await fs.unlink(spoolPath)
  })

  it('aborts a stalled spool, discarding what it buffered', async () => {
    const file = createFakeFile()
    const sink = new SpoolSink(
      { path: 'spool.mkv', settings },
      { openFile: file.open },
    )
    file.stall()
    sink.write(Buffer.from('abcdef'))
    const draining = sink.waitForDrain()

    await sink.abort()
    await draining

    file.release()
    expect(sink.writable).toBe(false)
    expect(sink.failure).toBeUndefined()
    sink.markStarted()
    expect(() => sink.throwIfFailed()).not.toThrow()
  })

  it('bounds an abort whose file never reports closing', async () => {
    const file = createFakeFile()
    Object.assign(file.stream, {
      _destroy: () => {
        // The close never completes.
      },
    })
    let expire: (() => void) | undefined
    const clock = {
      clearTimeout: vi.fn(),
      setTimeout: (callback: () => void) => {
        expire = callback
        return {} as NodeJS.Timeout
      },
    } as unknown as ClockBoundary
    const sink = new SpoolSink(
      { path: 'spool.mkv', settings },
      { clock, openFile: file.open },
    )
    let aborted = false
    const aborting = sink.abort().then(() => {
      aborted = true
    })
    await settle()
    expect(aborted).toBe(false)

    expire?.()
    await aborting
    expect(clock.clearTimeout).toHaveBeenCalledOnce()
  })

  it('waits for the file to open before it is ready', async () => {
    const file = createFakeFile()
    Object.assign(file.stream, { pending: true })
    const sink = new SpoolSink(
      { path: 'spool.mkv', settings },
      { openFile: file.open },
    )
    let ready = false
    void sink.ready.then(() => {
      ready = true
    })
    await settle()
    expect(ready).toBe(false)
    file.stream.emit('ready')
    await sink.ready
  })
})
