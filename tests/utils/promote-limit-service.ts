import WdioPuppeteerVideoService, { launcher } from '../../src/index.js'
import { DEFAULT_SPOOL_LIMITS } from '../../src/service/spool-budget.js'
import type { WdioPuppeteerVideoServiceOptions } from '../../src/types.js'

/**
 * The service with a tiny spool promote limit, from
 * `WDIO_SPOOL_PROMOTE_BYTES`, so a browser run promotes its recordings to live
 * encoders. The limit is not a public option: only a test configuration that
 * loads this module can set it.
 */
const promoteBytes = Number(process.env.WDIO_SPOOL_PROMOTE_BYTES)

if (!Number.isInteger(promoteBytes) || promoteBytes < 1) {
  throw new TypeError(
    `WDIO_SPOOL_PROMOTE_BYTES must be a positive integer, got "${process.env.WDIO_SPOOL_PROMOTE_BYTES ?? ''}"`,
  )
}

export default class PromoteLimitService extends WdioPuppeteerVideoService {
  constructor(
    options?: WdioPuppeteerVideoServiceOptions,
    capabilities?: unknown,
    config?: unknown,
  ) {
    super(options, capabilities, config, {
      spoolLimits: { ...DEFAULT_SPOOL_LIMITS, promoteBytes },
    })
  }
}

export { launcher }
