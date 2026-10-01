import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

export const writeFileAtomically = async (
  filePath: string,
  content: string,
): Promise<void> => {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  // Exclusive creation establishes ownership before a partial write can fail.
  const handle = await fs.open(temporaryPath, 'wx')
  try {
    try {
      await handle.writeFile(content, 'utf8')
    } finally {
      await handle.close()
    }
    await fs.rename(temporaryPath, filePath)
  } finally {
    // Preserve the write/publication error if storage also rejects cleanup.
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}
