import { fileURLToPath } from 'node:url'

// A run that sets WDIO_SPOOL_PROMOTE_BYTES loads the service with that spool
// promote limit; otherwise the service as published.
export const videoServiceModulePath = fileURLToPath(
  new URL(
    process.env.WDIO_SPOOL_PROMOTE_BYTES
      ? './promote-limit-service.ts'
      : '../../src/index.ts',
    import.meta.url,
  ),
)
