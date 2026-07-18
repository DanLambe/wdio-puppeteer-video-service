import type { FileHandle } from 'node:fs/promises'
import fs from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { isProcessAlive } from './retry-state.js'

export interface ClockBoundary {
  clearInterval(timer: NodeJS.Timeout): void
  clearTimeout(timer: NodeJS.Timeout): void
  delay(milliseconds: number): Promise<void>
  now(): number
  queueMicrotask(callback: () => void): void
  setInterval(callback: () => void, milliseconds: number): NodeJS.Timeout
  setTimeout(callback: () => void, milliseconds: number): NodeJS.Timeout
}

export interface FileStatsBoundary {
  birthtimeMs?: number
  ino?: number
  mtimeMs: number
  size?: number
}

export interface FileSystemBoundary {
  mkdir(dirPath: string): Promise<void>
  openExclusive(filePath: string): Promise<FileHandle>
  readText(filePath: string): Promise<string>
  stat(filePath: string): Promise<FileStatsBoundary>
  unlink(filePath: string): Promise<void>
}

export interface ProcessBoundary {
  readonly pid: number
  readonly platform: NodeJS.Platform
  environment(name: string): string | undefined
  isAlive(pid: number): boolean
}

export const systemClock: ClockBoundary = {
  clearInterval(timer): void {
    clearInterval(timer)
  },
  clearTimeout(timer): void {
    clearTimeout(timer)
  },
  async delay(milliseconds): Promise<void> {
    await delay(milliseconds)
  },
  now(): number {
    return Date.now()
  },
  queueMicrotask(callback): void {
    queueMicrotask(callback)
  },
  setInterval(callback, milliseconds): NodeJS.Timeout {
    return setInterval(callback, milliseconds)
  },
  setTimeout(callback, milliseconds): NodeJS.Timeout {
    return setTimeout(callback, milliseconds)
  },
}

export const nodeFileSystem: FileSystemBoundary = {
  async mkdir(dirPath): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true })
  },
  async openExclusive(filePath): Promise<FileHandle> {
    return fs.open(filePath, 'wx')
  },
  async readText(filePath): Promise<string> {
    return fs.readFile(filePath, 'utf8')
  },
  async stat(filePath): Promise<FileStatsBoundary> {
    return fs.stat(filePath)
  },
  async unlink(filePath): Promise<void> {
    await fs.unlink(filePath)
  },
}

export const nodeProcess: ProcessBoundary = {
  environment(name): string | undefined {
    return process.env[name]
  },
  isAlive: isProcessAlive,
  pid: process.pid,
  platform: process.platform,
}
