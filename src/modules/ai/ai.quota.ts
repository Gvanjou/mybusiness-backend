import { db } from '../../pkg/supabase/supabase.js'
import { logger, errorFields } from '../../shared/logger/logger.js'
import { sleep } from '../../shared/utils/async.js'
import { limitFor } from './ai.models.js'

type ModelState = {
  minute: number[] // request timestamps within the last 60 s
  day: number
  dayKey: string
  coolingUntil: number
  unhealthyUntil: number // recent timeout/overload: try other models first
}

const state = new Map<string, ModelState>()

// Gemini daily quotas reset at midnight Pacific time.
function pacificDayKey(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now)
}

function get(model: string): ModelState {
  let s = state.get(model)
  const key = pacificDayKey()
  if (!s) {
    s = { minute: [], day: 0, dayKey: key, coolingUntil: 0, unhealthyUntil: 0 }
    state.set(model, s)
  }
  if (s.dayKey !== key) {
    s.day = 0
    s.dayKey = key
  }
  return s
}

export const quota = {
  // Restore today's counters after a restart so the daily budget is not exceeded.
  async load(): Promise<void> {
    const { data, error } = await db.rpc('llm_usage_today')
    if (error) {
      logger.warn('quota.load failed; starting from zero', errorFields(error))
      return
    }
    for (const row of (data ?? []) as { model: string; requests: number }[]) get(row.model).day = Number(row.requests)
  },

  // Reserves a request slot. Waits up to maxWaitMs for the per-minute window;
  // returns false when the model is cooling down, out of daily quota, or the wait would be too long.
  // `share` caps the fraction of the daily quota this caller may use (jobs leave headroom for chat).
  async acquire(model: string, maxWaitMs: number, share = 1): Promise<boolean> {
    const limit = limitFor(model)
    const deadline = Date.now() + maxWaitMs
    for (;;) {
      const s = get(model)
      const now = Date.now()
      if (s.coolingUntil > now || s.day >= Math.floor(limit.rpd * share)) return false
      s.minute = s.minute.filter((t) => now - t < 60_000)
      if (s.minute.length < limit.rpm) {
        s.minute.push(now)
        s.day++
        return true
      }
      const waitMs = 60_000 - (now - s.minute[0]!) + 50
      if (now + waitMs > deadline) return false
      await sleep(Math.min(waitMs, deadline - now))
    }
  },

  // Called on a 429 from Google: our local view was optimistic, back off this model.
  coolDown(model: string, ms = 60_000): void {
    get(model).coolingUntil = Date.now() + ms
  },

  // Circuit breaker for slow or overloaded models (503, timeouts). They stay usable, just tried last.
  markUnhealthy(model: string, ms = 3 * 60_000): void {
    get(model).unhealthyUntil = Date.now() + ms
  },

  markHealthy(model: string): void {
    get(model).unhealthyUntil = 0
  },

  // Healthy models first, keeping the configured preference order within each group.
  order(chain: readonly string[]): string[] {
    const now = Date.now()
    const healthy = chain.filter((m) => get(m).unhealthyUntil <= now)
    return [...healthy, ...chain.filter((m) => !healthy.includes(m))]
  },

  snapshot(): Record<string, { minute: number; day: number; rpm: number; rpd: number; cooling: boolean }> {
    const out: Record<string, { minute: number; day: number; rpm: number; rpd: number; cooling: boolean }> = {}
    const now = Date.now()
    for (const [model, s] of state) {
      const limit = limitFor(model)
      out[model] = {
        minute: s.minute.filter((t) => now - t < 60_000).length,
        day: s.day,
        rpm: limit.rpm,
        rpd: limit.rpd,
        cooling: s.coolingUntil > now,
      }
    }
    return out
  },
}
