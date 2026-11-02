import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Marks the service's own recording work. WDIO runs service command hooks for
 * every command issued outside another command hook, including the ones this
 * service sends while it starts or stops capture from a test hook or a
 * Puppeteer callback. Those must neither steer recording nor queue behind the
 * serialized task that issued them, which would never finish.
 */
const internalOperation = new AsyncLocalStorage<true>()

export const runInternal = <T>(operation: () => T): T => {
  return internalOperation.run(true, operation)
}

export const isInternalOperation = (): boolean => {
  return internalOperation.getStore() === true
}
