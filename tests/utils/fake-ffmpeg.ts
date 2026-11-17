import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import { PassThrough, Writable } from 'node:stream'
import { vi } from 'vitest'

/**
 * A stand-in for an FFmpeg process that encodes a stream from its standard
 * input: it keeps every byte it is given, can hold its input still like an
 * encoder starved of CPU, and can exit when the test says so.
 */
export interface FakeFfmpegProcess {
  readonly args: readonly string[]
  readonly child: ChildProcess
  /** Everything written to its input so far. */
  bytes(): Buffer
  /** Exits as FFmpeg would, with this code. */
  exit(code: number | null, signal?: NodeJS.Signals | null): void
  readonly kill: ReturnType<typeof vi.fn>
  /** Lets held writes through, and stops holding. */
  release(): void
  /** Holds every write to the input until `release`. */
  stall(): void
  /** Whether its input was ended, as a recorder stop does. */
  readonly inputEnded: () => boolean
}

export interface FakeFfmpegOptions {
  readonly closeOnEnd?: boolean
  /** Writes its output file (the last argument) when its input ends. */
  readonly outputOnEnd?: string
  /** Fails to start, as a missing binary does: no start, then this error. */
  readonly spawnError?: Error
}

export const createFakeFfmpegProcess = (
  args: readonly string[] = [],
  { closeOnEnd = true, outputOnEnd, spawnError }: FakeFfmpegOptions = {},
): FakeFfmpegProcess => {
  const chunks: Buffer[] = []
  const waiting: Array<() => void> = []
  let flowing = true
  let ended = false
  let closed = false
  const child = new EventEmitter() as ChildProcess & {
    exitCode: number | null
    signalCode: NodeJS.Signals | null
  }
  const stdin = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      const accept = (): void => {
        chunks.push(Buffer.from(chunk))
        callback()
      }
      if (flowing) {
        accept()
      } else {
        waiting.push(accept)
      }
    },
  })
  const close = (): void => {
    if (closed) {
      return
    }
    closed = true
    // Like a process, the exit is reported a turn after the input ends.
    setImmediate(() => {
      child.exitCode ??= child.signalCode === null ? 0 : null
      child.emit('exit', child.exitCode, child.signalCode)
      child.emit('close', child.exitCode, child.signalCode)
    })
  }
  stdin.on('finish', () => {
    ended = true
    if (!closeOnEnd) {
      return
    }
    const output = args.at(-1)
    if (outputOnEnd !== undefined && output !== undefined) {
      void fs.writeFile(output, outputOnEnd).then(close, close)
    } else {
      close()
    }
  })
  const kill = vi.fn(() => {
    child.signalCode ??= 'SIGKILL'
    stdin.destroy()
    close()
    return true
  })
  Object.assign(child, {
    exitCode: null,
    kill,
    signalCode: null,
    stderr: new PassThrough(),
    stdin,
    stdout: null,
    unref: vi.fn(),
  })
  // Like child_process.spawn, report the start after the process is created.
  queueMicrotask(() => {
    if (spawnError) {
      child.emit('error', spawnError)
    } else {
      child.emit('spawn')
    }
  })
  return {
    args,
    child,
    bytes: () => Buffer.concat(chunks),
    exit: (code, signal = null) => {
      child.exitCode = code
      child.signalCode = signal
      close()
    },
    inputEnded: () => ended,
    kill,
    release: () => {
      flowing = true
      for (const accept of waiting.splice(0)) {
        accept()
      }
    },
    stall: () => {
      flowing = false
    },
  }
}
