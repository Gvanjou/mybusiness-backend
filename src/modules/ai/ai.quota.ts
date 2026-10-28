import { db } from '../../pkg/supabase/supabase.js'
import { logger, errorFields } from '../../shared/logger/logger.js'
import { sleep } from '../../shared/utils/async.js'
import { limitFor } from './ai.models.js'

type ModelState = {
  minute: number[] // request timestamps within the last 60 s
  day: number // attempts today (our own throttle)
  ok: number // answered requests today: what Google counts against the daily allowance
  exhausted: boolean // Google said today's allowance is used up (429 per day)
  dayKey: string
  coolingUntil: number
  unhealthyUntil: number // recent timeout/overload: try other models first
}

const state = new Map<string, ModelState>()

// Gemini daily quotas reset at midnight Pacific time.
function pacificDayKey(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now)
}

// Midnight Pacific: offset 0 = the next reset, -1 = the last one. Found by stepping over the date change, which
// handles daylight saving without a time-zone library.
function resetTime(offset: 0 | -1): Date {
  const now = Date.now()
  const today = pacificDayKey(new Date(now))
  let lo = now
  let hi = now + 26 * 3_600_000
  if (offset === -1) {
    lo = now - 26 * 3_600_000
    hi = now
    while (hi - lo > 60_000) {
      const mid = (lo + hi) / 2
      if (pacificDayKey(new Date(mid)) === today) hi = mid
      else lo = mid
    }
    return toMinute(hi)
  }
  while (hi - lo > 60_000) {
    const mid = (lo + hi) / 2
    if (pacificDayKey(new Date(mid)) === today) lo = mid
    else hi = mid
  }
  return toMinute(hi)
}

// The search ends within a minute after the change of day: rounding down gives the exact minute (11:00, not 11:01).
const toMinute = (ms: number) => new Date(Math.floor(ms / 60_000) * 60_000)

function get(model: string): ModelState {
  let s = state.get(model)
  const key = pacificDayKey()
  if (!s) {
    s = { minute: [], day: 0, ok: 0, exhausted: false, dayKey: key, coolingUntil: 0, unhealthyUntil: 0 }
    state.set(model, s)
  }
  if (s.dayKey !== key) {
    s.day = 0
    s.ok = 0
    s.exhausted = false
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
    // Answered requests since the reset, for the shared usage figure.
    const { data: ok, error: okError } = await db.from('llm_usage').select('model').eq('outcome', 'ok').gte('created_at', resetTime(-1).toISOString())
    if (okError) logger.warn('quota.load: answered requests unavailable', errorFields(okError))
    for (const row of ok ?? []) get(String(row.model)).ok++
  },

  recordOk(model: string): void {
    get(model).ok++
  },

  // Google refused for the rest of the day: no more tries until the reset, and the model counts as fully used.
  markExhausted(model: string): void {
    const s = get(model)
    s.exhausted = true
    s.coolingUntil = resetTime(0).getTime()
  },

  // Today's use of the free allowance across these models: answered requests (a used-up model counts in full).
  usage(models: string[]): { used: number; total: number; resetsAt: string } {
    let used = 0
    let total = 0
    for (const m of models) {
      const { rpd } = limitFor(m)
      const s = get(m)
      total += rpd
      used += s.exhausted ? rpd : Math.min(s.ok, rpd)
    }
    return { used, total, resetsAt: resetTime(0).toISOString() }
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
      // The daily allowance is judged by answered requests and by Google's own "used up" reply, not by attempts:
      // a model that was busy (503) many times today has not spent its allowance.
      if (s.coolingUntil > now || s.exhausted || s.ok >= Math.floor(limit.rpd * share)) return false
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
  // Free-tier overloads last a while: 10 minutes at the back of the line spares the next chats the wait.
  markUnhealthy(model: string, ms = 10 * 60_000): void {
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
