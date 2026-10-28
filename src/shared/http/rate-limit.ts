import { AppError } from './app-error.js'

type Window = { count: number; resetAt: number }

const MAX_KEYS = 100_000

// Fixed-window counter in process memory. Good for a single backend instance;
// with several instances, move the counters to Redis or Postgres.
export class RateLimiter {
  private readonly windows = new Map<string, Window>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    setInterval(() => this.sweep(), Math.min(windowMs, 60_000)).unref()
  }

  // Throws AppError('rate_limited') when the key is over its limit.
  hit(key: string): void {
    const now = Date.now()
    const w = this.windows.get(key)
    if (!w || w.resetAt <= now) {
      if (!w && this.windows.size >= MAX_KEYS) {
        this.sweep()
        // Too many distinct keys (e.g. spoofed addresses): refuse new ones rather than grow without bound.
        if (this.windows.size >= MAX_KEYS) throw new AppError('rate_limited', 'Too many requests, please try again later.', 60)
      }
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs })
      return
    }
    if (w.count >= this.limit) {
      throw new AppError('rate_limited', 'Too many requests, please slow down.', Math.ceil((w.resetAt - now) / 1000))
    }
    w.count++
  }

  private sweep() {
    const now = Date.now()
    for (const [key, w] of this.windows) if (w.resetAt <= now) this.windows.delete(key)
  }
}
