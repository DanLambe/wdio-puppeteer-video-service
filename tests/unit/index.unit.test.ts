import { describe, expect, it } from 'vitest'
import DefaultExport, {
  launcher,
  WdioPuppeteerVideoService,
} from '../../src/index.js'

describe('index exports', () => {
  it('keeps default and named exports aligned', () => {
    expect(DefaultExport).toBeTypeOf('function')
    expect(WdioPuppeteerVideoService).toBeTypeOf('function')
    expect(DefaultExport).toBe(WdioPuppeteerVideoService)
  })

  it('exposes a distinct WDIO launcher class', () => {
    expect(launcher).toBeTypeOf('function')
    expect(launcher).not.toBe(WdioPuppeteerVideoService)
    expect(launcher.prototype).toHaveProperty('onPrepare')
    expect(launcher.prototype).toHaveProperty('onWorkerStart')
    expect(WdioPuppeteerVideoService.prototype).not.toHaveProperty('onPrepare')
    expect(WdioPuppeteerVideoService.prototype).not.toHaveProperty(
      'onWorkerStart',
    )
  })
})
