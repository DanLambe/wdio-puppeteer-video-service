import type { Frameworks } from '@wdio/types'
import VideoService from '../../../src/service.js'
import { timeHook } from './metrics.js'

export { default as launcher } from '../../../src/launcher.js'

/** Time the public hook boundary, including startup and artifact finalization. */
export default class InstrumentedVideoService extends VideoService {
  override async beforeTest(test: Frameworks.Test, context: unknown) {
    await timeHook('startupMs', () => super.beforeTest(test, context))
  }

  override async afterTest(
    test: Frameworks.Test,
    context: unknown,
    result: Frameworks.TestResult,
  ) {
    await timeHook('stopMs', () => super.afterTest(test, context, result))
  }
}
