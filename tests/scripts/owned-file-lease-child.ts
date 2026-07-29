import { tryAcquireOwnedFileLease } from '../../src/service/owned-file-lease.js'

const leasePath = process.argv[2]
const mode = process.argv[3] ?? 'release'
if (!leasePath) {
  throw new Error('Expected an owned-file lease path')
}

const lease = await tryAcquireOwnedFileLease({
  filePath: leasePath,
  heartbeatIntervalMs: 25,
  invalidStaleMs: 100,
  payload: { child: true },
})
if (!lease) {
  process.stdout.write('BLOCKED\n')
} else {
  process.stdout.write('ACQUIRED\n')
  if (mode === 'hold') {
    setInterval(() => {
      /* keep the worker alive until the parent terminates it */
    }, 1_000)
    await new Promise<void>(() => {
      /* wait for the parent test to terminate this process */
    })
  }
  await lease.release()
}
