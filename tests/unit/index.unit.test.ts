import { describe, expect, it } from 'vitest'
import DefaultExport, { WdioPuppeteerVideoService } from '../../src/index.js'

describe('index exports', () => {
  it('keeps default and named exports aligned', () => {
    expect(DefaultExport).toBeTypeOf('function')
    expect(WdioPuppeteerVideoService).toBeTypeOf('function')
    expect(DefaultExport).toBe(WdioPuppeteerVideoService)
  })
})
