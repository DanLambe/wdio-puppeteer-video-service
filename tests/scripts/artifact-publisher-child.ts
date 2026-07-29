import fs from 'node:fs/promises'
import { publishAtomicArtifact } from '../../src/service/artifact-integrity.js'

const desiredPath = process.argv[2]
const contents = process.argv[3]
const mode = process.argv[4]
if (!desiredPath || !contents) {
  throw new Error('Expected an artifact path and contents')
}

const publishedPath = await publishAtomicArtifact({
  desiredPath,
  produce: async (temporaryPath) => {
    await fs.writeFile(temporaryPath, contents, 'utf8')
    if (mode === 'hang') {
      process.stdout.write('READY\n')
      setInterval(() => {
        /* keep the worker alive until the parent terminates it */
      }, 1_000)
      await new Promise<void>(() => {
        /* wait for the parent test to terminate this worker */
      })
    }
    return true
  },
  validate: async () => true,
  warn: (message) => {
    process.stderr.write(`${message}\n`)
  },
})

if (!publishedPath) {
  throw new Error('Artifact publication failed')
}
process.stdout.write(publishedPath)
