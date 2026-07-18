import { describe, expect, it } from 'vitest'
import {
  formatLogMessage,
  normalizeLogLevel,
  resolveWdioLogLevel,
  shouldLog,
} from '../../src/service/logging.js'

describe('service logging contract', () => {
  it('normalizes supported levels and falls back to warn', () => {
    expect(normalizeLogLevel('trace')).toBe('trace')
    expect(normalizeLogLevel('ERROR')).toBe('error')
    expect(normalizeLogLevel('invalid')).toBe('warn')
    expect(normalizeLogLevel(undefined)).toBe('warn')
  })

  it('resolves browser options before config', () => {
    expect(
      resolveWdioLogLevel({
        options: { logLevel: 'debug' },
        config: { logLevel: 'error' },
      } as never),
    ).toBe('debug')
  })

  it('applies priority and service-prefix rules', () => {
    expect(shouldLog('error', 'warn')).toBe(true)
    expect(shouldLog('debug', 'warn')).toBe(false)
    expect(formatLogMessage('message')).toBe(
      '[WdioPuppeteerVideoService] message',
    )
    expect(formatLogMessage('[WdioPuppeteerVideoService] message')).toBe(
      '[WdioPuppeteerVideoService] message',
    )
  })
})
