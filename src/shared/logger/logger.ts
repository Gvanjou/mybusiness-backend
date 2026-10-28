import { env } from '../../pkg/env/env.js'

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const
type Level = keyof typeof levels

const threshold = levels[env.LOG_LEVEL]

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (levels[level] < threshold) return
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields })
  if (level === 'error' || level === 'warn') console.error(line)
  else console.log(line)
}

// Structured JSON logs. Never log message text, tokens, keys or personal data.
export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
}

export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { error: err.name, detail: err.message.slice(0, 300) }
  return { error: String(err).slice(0, 300) }
}
