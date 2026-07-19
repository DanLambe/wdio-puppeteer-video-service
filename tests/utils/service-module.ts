import { fileURLToPath } from 'node:url'

export const videoServiceModulePath = fileURLToPath(
  new URL('../../src/index.ts', import.meta.url),
)
