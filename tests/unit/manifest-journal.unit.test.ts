import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManifestJournalWriter } from '../../src/service/manifest-journal.js'

const tempDirs: string[] = []

const createTempDir = async (): Promise<string> => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wdio-video-journal-unit-'),
  )
  tempDirs.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    tempDirs.map((directory) =>
      fs.rm(directory, { recursive: true, force: true }).catch(() => undefined),
    ),
  )
  tempDirs.length = 0
})

const createWriter = (
  journalPath: string,
): { onError: ReturnType<typeof vi.fn>; writer: ManifestJournalWriter } => {
  const onError = vi.fn()
  return {
    onError,
    writer: new ManifestJournalWriter({
      failurePolicy: 'warn',
      journalPath,
      onError,
    }),
  }
}

const entryEvent = (id: string) => ({ type: 'entry', entry: { id } }) as never

describe('manifest journal writer', () => {
  it('appends every event as its own line', async () => {
    const tempDir = await createTempDir()
    const journalPath = path.join(tempDir, 'journals', 'worker.jsonl')
    const { onError, writer } = createWriter(journalPath)

    await writer.append(entryEvent('one'))
    await writer.append(entryEvent('two'))
    await writer.flush()

    const lines = (await fs.readFile(journalPath, 'utf8')).trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(onError).not.toHaveBeenCalled()
  })

  it('recreates a journal directory that disappears mid-run', async () => {
    // The directory used to be created on every append, which made this
    // self-healing. Creating it once is cheaper, but must keep that property:
    // cleanup elsewhere in the run should not silently lose later events.
    const tempDir = await createTempDir()
    const journalDir = path.join(tempDir, 'journals')
    const journalPath = path.join(journalDir, 'worker.jsonl')
    const { onError, writer } = createWriter(journalPath)

    await writer.append(entryEvent('before'))
    await fs.rm(journalDir, { recursive: true, force: true })
    await writer.append(entryEvent('after'))
    await writer.flush()

    const contents = await fs.readFile(journalPath, 'utf8')
    expect(contents).toContain('after')
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports a write failure through onError under the warn policy', async () => {
    const tempDir = await createTempDir()
    // A directory where the journal file should be makes appending fail.
    const journalPath = path.join(tempDir, 'journals', 'worker.jsonl')
    await fs.mkdir(journalPath, { recursive: true })
    const { onError, writer } = createWriter(journalPath)

    await writer.append(entryEvent('one'))

    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0]?.[0]).toBe('write the worker manifest journal')
  })
})
