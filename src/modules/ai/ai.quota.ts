import { db } from '../../pkg/supabase/supabase.js'
import { logger, errorFields } from '../../shared/logger/logger.js'
import { sleep } from '../../shared/utils/async.js'
import { chatModels, KEY_ID, MODEL_INFO, limitFor } from './ai.models.js'

// One recent call: did the model answer, and how long it took to start (time to the first streamed chunk for the
// chat; the whole call for the other tasks).
type Sample = { at: number; ok: boolean; ms?: number; task?: string }

type ModelState = {
  minute: number[] // request timestamps within the last 60 s
  day: number // attempts today (our own throttle)
  ok: number // answered requests today: what Google counts against the daily allowance
  exhausted: boolean // Google said today's allowance is used up (429 per day)
  dayKey: string
  coolingUntil: number
  recent: Sample[] // the last hour of calls: decides health and speed (see order)
  lastOkAt: number // the last answer and the last failure (0 = none): whether it answered at all within the day
  lastFailAt: number
}

// Measured on 2026-10-28: two Flash models failed almost every call all day (1 of 57 and 0 of 65 answered), each
// failure costing 8–30 s before the next model was tried. A fixed 2–5 min break put them first again as soon as it
// ended, so the break grows with every failure in a row and a success ends it.
const WINDOW_MS = 60 * 60_000
const COOL_OFF_MS = [2, 5, 15, 30].map((min) => min * 60_000)
// Speeds closer than this are a tie, so the order does not flip on noise; the chain's preference decides.
const SPEED_STEP_MS = 2_000
// The hour above forgets: after a quiet hour a model that failed all day looked new and went first again (the first
// heavy question of a session would wait on two dead models). Whether a model answered at all is kept for a day.
const DAY_MS = 24 * 3_600_000

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
    s = { minute: [], day: 0, ok: 0, exhausted: false, dayKey: key, coolingUntil: 0, recent: [], lastOkAt: 0, lastFailAt: 0 }
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

function record(model: string, sample: Sample): void {
  const s = get(model)
  s.recent = [...s.recent.filter((x) => sample.at - x.at < WINDOW_MS), sample].sort((a, b) => a.at - b.at)
  remember(s, sample.ok, sample.at)
}

function remember(s: ModelState, ok: boolean, at: number): void {
  if (ok) s.lastOkAt = Math.max(s.lastOkAt, at)
  else s.lastFailAt = Math.max(s.lastFailAt, at)
}

// Within the day: 0 = answered (one answer is enough), 1 = not tried, 2 = failed and never answered.
function standing(s: ModelState, now: number): 0 | 1 | 2 {
  if (now - s.lastOkAt < DAY_MS) return 0
  return now - s.lastFailAt < DAY_MS ? 2 : 1
}

// When a model that failed recently may be tried first again: the more failures in a row (since its last answer,
// within the hour), the longer it waits. 0 = healthy now.
function backAt(s: ModelState, now: number): number {
  const recent = s.recent.filter((x) => now - x.at < WINDOW_MS)
  let failures = 0
  for (let i = recent.length - 1; i >= 0 && !recent[i]!.ok; i--) failures++
  if (!failures) return 0
  const until = recent.at(-1)!.at + COOL_OFF_MS[Math.min(failures, COOL_OFF_MS.length) - 1]!
  return until > now ? until : 0
}

// The median time this model took to start answering this task within the hour; null when it has not answered.
function speedOf(s: ModelState, task: string, now: number): number | null {
  const times = s.recent.filter((x) => x.ok && x.ms !== undefined && x.task === task && now - x.at < WINDOW_MS).map((x) => x.ms!)
  if (!times.length) return null
  return [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]!
}

const tierOf = (model: string) => MODEL_INFO[model]?.tier ?? 'other'

export const quota = {
  // Restore today's counters after a restart so the daily budget is not exceeded.
  // Today's answered requests made with the current key, so a restart keeps the figure and a new key starts at zero.
  async load(): Promise<void> {
    const { data, error } = await db.from('llm_usage').select('model').eq('outcome', 'ok').eq('key_id', KEY_ID).gte('created_at', resetTime(-1).toISOString())
    if (error) {
      logger.warn('quota.load: usage log unavailable (run migration 014?); starting from zero', errorFields(error))
      return
    }
    for (const row of data ?? []) get(String(row.model)).ok++
    // The last hour of calls, so a restart does not relearn which models are failing by failing again. Logged times
    // are whole calls (the end of the stream for the chat): an upper bound on the time to start, replaced within the
    // hour by what this process measures. Rate limits (429) are left out: they have their own handling above.
    const since = new Date(Date.now() - WINDOW_MS).toISOString()
    const recent = await db.from('llm_usage').select('model, task, outcome, latency_ms, created_at').gte('created_at', since).in('outcome', ['ok', 'error'])
    if (recent.error) return logger.warn('quota.load: recent calls unavailable; model order starts from the defaults', errorFields(recent.error))
    for (const row of recent.data ?? []) {
      const at = new Date(String(row.created_at)).getTime()
      const ok = row.outcome === 'ok'
      record(String(row.model), { at, ok, ms: ok && typeof row.latency_ms === 'number' ? row.latency_ms : undefined, task: String(row.task) })
    }
    // And over the day, only each model's last answer and last failure (one small query each, not every row).
    const day = new Date(Date.now() - DAY_MS).toISOString()
    const last = (model: string, outcome: 'ok' | 'error') =>
      db.from('llm_usage').select('created_at').eq('model', model).eq('outcome', outcome).gte('created_at', day).order('created_at', { ascending: false }).limit(1)
    await Promise.all(
      chatModels().flatMap((model) =>
        (['ok', 'error'] as const).map(async (outcome) => {
          const { data: rows, error: failed } = await last(model, outcome)
          if (failed) return logger.warn('quota.load: the day of calls unavailable', { model, ...errorFields(failed) })
          if (rows?.[0]) remember(get(model), outcome === 'ok', new Date(String(rows[0].created_at)).getTime())
        }),
      ),
    )
  },

  // For the model picker: used up today (limit), recently busy or slow (busy), or ready (available).
  status(model: string): { status: 'available' | 'busy' | 'limit'; used: number; limit: number } {
    const s = get(model)
    const { rpd } = limitFor(model)
    const now = Date.now()
    // used = answers it gave here today. Google may report its limit reached earlier (the limit is per project,
    // shared with other keys and with requests that failed), so the state comes from Google's reply, the count from us.
    const used = Math.min(s.ok, rpd)
    if (s.exhausted || used >= rpd) return { status: 'limit', used, limit: rpd }
    return { status: backAt(s, now) || s.coolingUntil > now ? 'busy' : 'available', used, limit: rpd }
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

  // An answer, and how long the model took to start it. Ends any cool-off.
  recordSuccess(model: string, ms: number, task: string, at = Date.now()): void {
    record(model, { at, ok: true, ms, task })
  },

  // Circuit breaker for slow or overloaded models (503, timeouts, network errors). They stay usable, just tried
  // after the healthy ones, for longer with every failure in a row (2, 5, 15, then 30 min).
  recordFailure(model: string, at = Date.now()): void {
    record(model, { at, ok: false })
  },

  // The order to try a chain in. Healthy models first; within each tier block of the chain (chainFor puts Flash or
  // Flash-Lite first): the models that answered within the day, the faster ones first (median time to start within
  // the hour; equal speeds and unmeasured ones in chain order); then those not tried within the day, in chain order;
  // then those that failed and never answered within the day. Models cooling off go last, the soonest back first.
  order(chain: readonly string[], task = 'responder'): string[] {
    const now = Date.now()
    const index = new Map(chain.map((m, i) => [m, i]))
    const healthy = chain.filter((m) => !backAt(get(m), now))
    const blocks: string[][] = []
    for (const m of healthy) {
      const last = blocks.at(-1)
      if (last && tierOf(last[0]!) === tierOf(m)) last.push(m)
      else blocks.push([m])
    }
    const step = (m: string) => {
      const ms = speedOf(get(m), task, now)
      return ms === null ? Infinity : Math.ceil(ms / SPEED_STEP_MS)
    }
    const rank = (m: string) => standing(get(m), now)
    const fastFirst = blocks.flatMap((b) => [...b].sort((a, c) => rank(a) - rank(c) || step(a) - step(c) || index.get(a)! - index.get(c)!))
    const cooling = chain.filter((m) => !healthy.includes(m)).sort((a, c) => backAt(get(a), now) - backAt(get(c), now) || index.get(a)! - index.get(c)!)
    return [...fastFirst, ...cooling]
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
