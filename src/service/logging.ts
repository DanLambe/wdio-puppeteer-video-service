import type { Browser } from 'webdriverio'
import type { WdioPuppeteerVideoServiceLogLevel } from '../types.js'
import {
  LOG_LEVEL_PRIORITY,
  LOG_METHOD_MAP,
  SERVICE_LOG_PREFIX,
} from './constants.js'

export const resolveWdioLogLevel = (browser: Browser): string | undefined => {
  const browserWithOptions = browser as Browser & {
    options?: { logLevel?: string }
    config?: { logLevel?: string }
  }

  return (
    browserWithOptions.options?.logLevel ||
    browserWithOptions.config?.logLevel ||
    process.env.WDIO_LOG_LEVEL
  )
}

export const normalizeLogLevel = (
  level: string | undefined,
): WdioPuppeteerVideoServiceLogLevel => {
  const normalized = (level || '').toLowerCase()
  if (normalized in LOG_LEVEL_PRIORITY) {
    return normalized as WdioPuppeteerVideoServiceLogLevel
  }
  return 'warn'
}

export const shouldLog = (
  level: WdioPuppeteerVideoServiceLogLevel,
  activeLevel: WdioPuppeteerVideoServiceLogLevel,
): boolean => {
  return LOG_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[activeLevel]
}

export const formatLogMessage = (message: string): string => {
  if (message.startsWith(SERVICE_LOG_PREFIX)) {
    return message
  }

  return `${SERVICE_LOG_PREFIX} ${message}`
}

export const writeLog = (
  activeLevel: WdioPuppeteerVideoServiceLogLevel,
  level: WdioPuppeteerVideoServiceLogLevel,
  message: string,
  details?: unknown,
): void => {
  if (!shouldLog(level, activeLevel)) {
    return
  }

  const formattedMessage = formatLogMessage(message)
  const logMethod = LOG_METHOD_MAP[level] ?? console.debug

  if (details === undefined) {
    logMethod(formattedMessage)
  } else {
    logMethod(formattedMessage, details)
  }
}
