export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const LEVEL_WEIGHT: Record<Exclude<LogLevel, 'silent'>, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

function normalizeLevel(value: unknown): LogLevel {
  return value === 'debug'
    || value === 'info'
    || value === 'warn'
    || value === 'error'
    || value === 'silent'
    ? value
    : 'info'
}

export interface ScanLogger {
  debug(event: string, fields?: Record<string, unknown>): void
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

export function createScanLogger(scanId: string, configuredLevel: unknown): ScanLogger {
  const level = normalizeLevel(configuredLevel)

  function write(
    messageLevel: Exclude<LogLevel, 'silent'>,
    event: string,
    fields: Record<string, unknown> = {},
  ): void {
    if (level === 'silent') return
    if (LEVEL_WEIGHT[messageLevel] < LEVEL_WEIGHT[level]) return

    const payload = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: messageLevel,
      service: 'yt-checker',
      scanId,
      event,
      ...fields,
    })

    if (messageLevel === 'error') console.error(payload)
    else if (messageLevel === 'warn') console.warn(payload)
    else console.log(payload)
  }

  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  }
}
