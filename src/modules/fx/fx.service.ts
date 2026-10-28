import { z } from 'zod'
import { logger, errorFields } from '../../shared/logger/logger.js'

// Official National Bank of Georgia rates, fetched when needed and kept in memory for a few hours.
const NBG_URL = 'https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/en/json/?currencies=USD,EUR'
const TTL_MS = 6 * 3_600_000

const nbgSchema = z.array(z.object({ date: z.string(), currencies: z.array(z.object({ code: z.string(), rate: z.number().positive(), quantity: z.number().positive() })) }))

// Without a date the API gives its latest published rates; for a day it may answer an empty list (on 2026-10-28 it
// did so for every recent day for hours, while the latest rates came back fine).
async function ratesFor(day?: Date): Promise<FxRates | null> {
  const res = await fetch(day ? `${NBG_URL}&date=${day.toISOString().slice(0, 10)}` : NBG_URL, { signal: AbortSignal.timeout(5_000) })
  if (!res.ok) throw new Error(`NBG API ${res.status}`)
  const [first] = nbgSchema.parse(await res.json())
  if (!first?.currencies.length) return null
  const rates: FxRates = { ...FALLBACK }
  for (const c of first.currencies) rates[c.code] = c.rate / c.quantity
  return rates
}

export type FxRates = Record<string, number> // GEL per 1 unit

// Used only until the National Bank answers once. Then the last rates it gave are kept, also past their few hours,
// whenever it does not answer: a price must not jump between 51 920 ₾ and 52 000 ₾ in one chat because the rate
// switched to this fallback and back (round 6).
const FALLBACK: FxRates = { GEL: 1, USD: 2.6, EUR: 2.9 }
// Without any NBG answer yet, the fallback is kept for a while instead of asking NBG on every listing refresh.
const RETRY_MS = 15 * 60_000

let cached: { at: number; rates: FxRates; fromNbg: boolean } | null = null

export const fxService = {
  async latest(): Promise<FxRates> {
    if (cached && Date.now() - cached.at < (cached.fromNbg ? TTL_MS : RETRY_MS)) return cached.rates
    try {
      for (const day of [undefined, ...[0, 1, 2, 3].map((back) => new Date(Date.now() - back * 86_400_000))]) {
        const rates = await ratesFor(day)
        if (rates) {
          cached = { at: Date.now(), rates, fromNbg: true }
          return rates
        }
      }
      throw new Error('NBG published no rates for the last days')
    } catch (err) {
      logger.warn(cached?.fromNbg ? 'NBG rates unavailable; keeping the last ones' : 'NBG rates unavailable; using fallback', errorFields(err))
      // The last NBG rates stay in use (their age is reset, so NBG is asked again later, not on every refresh).
      cached = { at: Date.now(), rates: cached?.rates ?? { ...FALLBACK }, fromNbg: cached?.fromNbg ?? false }
      return cached.rates
    }
  },
}

export function toGel(amount: number | null | undefined, currency: string | null | undefined, rates: FxRates): number | null {
  if (amount === null || amount === undefined || !Number.isFinite(amount) || amount <= 0) return null
  const rate = rates[(currency ?? 'GEL').toUpperCase()]
  return rate ? amount * rate : null
}

// A converted amount, rounded so a daily change of the rate does not show (production test: one listing at 52 000,
// 51 920 and 51 914 ₾ in one evening): to 1 000 from 10 000 up, to 100 from 1 000, else to 10.
export function approx(amount: number): number {
  const step = amount >= 10_000 ? 1_000 : amount >= 1_000 ? 100 : 10
  return Math.round(amount / step) * step
}
