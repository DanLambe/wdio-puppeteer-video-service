import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export const hashTree = async (base: string): Promise<string> => {
  const files = (
    await fs.readdir(base, { recursive: true, withFileTypes: true })
  )
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort((left, right) => {
      // Preserve the original UTF-16 ordering across locales and saved runs.
      if (left === right) {
        return 0
      }
      return left < right ? -1 : 1
    })
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(path.relative(base, file).replaceAll('\\', '/'))
    hash.update(await fs.readFile(file))
  }
  return hash.digest('hex')
}
