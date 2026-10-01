import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileAtomically } from '../../src/reporter/atomic-write.js'

let directory: string
let destination: string

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'report-publication-'))
  destination = path.join(directory, 'report.html')
  await fs.writeFile(destination, 'previous report')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(directory, { recursive: true, force: true })
})

describe('atomic report publication', () => {
  it('replaces a previous report without leaving temporary files', async () => {
    await writeFileAtomically(destination, 'replacement report')
    expect(await fs.readFile(destination, 'utf8')).toBe('replacement report')
    expect(await fs.readdir(directory)).toEqual(['report.html'])
  })

  it('closes and removes a partially written file when writing fails', async () => {
    const open = fs.open.bind(fs)
    const failure = new Error('storage exhausted')
    const close = vi.fn()
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      const write = handle.writeFile.bind(handle)
      const release = handle.close.bind(handle)
      vi.spyOn(handle, 'writeFile').mockImplementation(async () => {
        await write('partial bytes')
        throw failure
      })
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        close()
        await release()
      })
      return handle
    })
    await expect(writeFileAtomically(destination, 'new report')).rejects.toBe(
      failure,
    )
    expect(close).toHaveBeenCalledTimes(1)
    expect(await fs.readFile(destination, 'utf8')).toBe('previous report')
    expect(await fs.readdir(directory)).toEqual(['report.html'])
  })

  it('preserves the existing report when publication fails', async () => {
    const failure = new Error('rename denied')
    vi.spyOn(fs, 'rename').mockRejectedValue(failure)
    await expect(writeFileAtomically(destination, 'new report')).rejects.toBe(
      failure,
    )
    expect(await fs.readFile(destination, 'utf8')).toBe('previous report')
    expect(await fs.readdir(directory)).toEqual(['report.html'])
  })

  it('does not remove a file it could not exclusively create', async () => {
    const failure = new Error('exclusive open denied')
    const remove = vi.spyOn(fs, 'rm')
    const open = vi.spyOn(fs, 'open').mockRejectedValue(failure)
    await expect(writeFileAtomically(destination, 'new report')).rejects.toBe(
      failure,
    )
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/u), 'wx')
    expect(remove).not.toHaveBeenCalled()
    expect(await fs.readFile(destination, 'utf8')).toBe('previous report')
  })

  it('preserves the publication error if temporary cleanup also fails', async () => {
    const failure = new Error('rename denied')
    vi.spyOn(fs, 'rename').mockRejectedValue(failure)
    vi.spyOn(fs, 'rm').mockRejectedValue(new Error('cleanup denied'))
    await expect(writeFileAtomically(destination, 'new report')).rejects.toBe(
      failure,
    )
    expect(await fs.readFile(destination, 'utf8')).toBe('previous report')
  })
})
