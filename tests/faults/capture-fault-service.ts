import { startScreencast } from '../../src/service/capture.js'
import WdioPuppeteerVideoService from '../../src/service.js'

export { launcher } from '../../src/index.js'

/** Global the spec calls to reject the next capture start on one page. */
export const REJECT_NEXT_CAPTURE_START = 'rejectNextCaptureStart'

// Rejects one screencast start, chosen by page URL, so a browser test can
// check what the service reports for a driven tab it could not record. The
// error leaves the real capture engine as any start failure would.
export default class CaptureFaultService extends WdioPuppeteerVideoService {
  constructor(
    options?: ConstructorParameters<typeof WdioPuppeteerVideoService>[0],
    capabilities?: unknown,
    config?: unknown,
  ) {
    let rejectedUrl: string | undefined
    Reflect.set(globalThis, REJECT_NEXT_CAPTURE_START, (url: string) => {
      rejectedUrl = url
    })
    super(options, capabilities, config, {
      startScreencast: async (page, startOptions) => {
        if (rejectedUrl !== undefined && page.url().includes(rejectedUrl)) {
          rejectedUrl = undefined
          throw new Error('Injected capture start rejection')
        }
        return startScreencast(page, startOptions)
      },
    })
  }
}
