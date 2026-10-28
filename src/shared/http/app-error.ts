export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'no_session'
  | 'rate_limited'
  | 'payload_too_large'
  | 'session_expired'
  | 'ai_unavailable'
  | 'daily_limit'
  | 'model_unavailable'
  | 'internal'

const statusByCode: Record<ErrorCode, 400 | 401 | 403 | 404 | 413 | 429 | 500 | 503> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  no_session: 404, // no conversation open yet: the UI starts one
  payload_too_large: 413,
  rate_limited: 429,
  session_expired: 401,
  ai_unavailable: 503,
  daily_limit: 429,
  model_unavailable: 503, // the model the client picked is busy or used up: the UI offers another
  internal: 500,
}

// Errors safe to show to clients: code + short message, no internals.
export class AppError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 413 | 429 | 500 | 503

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
    readonly details?: Record<string, unknown>, // safe extra fields for the UI (e.g. which model, why)
  ) {
    super(message)
    this.name = 'AppError'
    this.status = statusByCode[code]
  }
}
