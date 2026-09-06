import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cleanupGlobalSlotRunDirectory,
  resolveGlobalSlotRunDirectories,
} from '../../src/service/global-slot-directory.js'

describe('global slot run directories', () => {
  it('resolves independent pools beneath the same run for default and explicit roots', () => {
    expect(resolveGlobalSlotRunDirectories({ runId: 'run-1' }).root).toBe(
      path.join('videos', '.wdio-video-global-slots'),
    )
    const directories = resolveGlobalSlotRunDirectories({
      lockDir: 'shared',
      runId: 'run-1',
    })
    expect(directories.recording).toBe(path.join('shared', 'run-1'))
    expect(directories.postProcess).toBe(
      path.join('shared', 'run-1', 'post-process'),
    )
  })

  it.each([
    '',
    '.',
    '..',
    '../sibling',
    'a/b',
    'a\\b',
    'C:\\root',
    'run.',
    'run ',
  ])(
    'rejects unsafe run ID %j before resolving or deleting paths',
    async (runId) => {
      expect(() => resolveGlobalSlotRunDirectories({ runId })).toThrow('unsafe')
      await expect(cleanupGlobalSlotRunDirectory({ runId })).rejects.toThrow(
        'unsafe',
      )
    },
  )

  it('removes only the completed run and preserves its root and sibling runs', async () => {
    const lockDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'slot-directories-'),
    )
    try {
      const finished = resolveGlobalSlotRunDirectories({
        lockDir,
        runId: 'finished',
      })
      const sibling = resolveGlobalSlotRunDirectories({
        lockDir,
        runId: 'active',
      })
      await fs.mkdir(finished.postProcess, { recursive: true })
      await fs.mkdir(sibling.recording)
      await fs.writeFile(
        path.join(finished.postProcess, 'slot-1.lock'),
        'abandoned',
      )
      await fs.writeFile(
        path.join(sibling.recording, 'slot-1.lock'),
        'preserved',
      )
      await cleanupGlobalSlotRunDirectory({ lockDir, runId: 'finished' })
      await cleanupGlobalSlotRunDirectory({ lockDir, runId: 'finished' })
      expect(await fs.readdir(lockDir)).toEqual(['active'])
      expect(
        await fs.readFile(path.join(sibling.recording, 'slot-1.lock'), 'utf8'),
      ).toBe('preserved')
    } finally {
      await fs.rm(lockDir, { force: true, recursive: true })
    }
  })
})
