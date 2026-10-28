import { z } from 'zod'
import { logger, errorFields } from '../../shared/logger/logger.js'

// Official National Bank of Georgia rates, fetched when needed and kept in memory for a few hours.
const NBG_URL = 'https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/en/json/?currencies=USD,EUR'
const TTL_MS = 6 * 3_600_000

const nbgSchema = z.array(z.object({ date: z.string(), currencies: z.array(z.object({ code: z.string(), rate: z.number().positive(), quantity: z.number().positive() })) }))

// The API answers an empty list without a date, and sometimes for a day it has not published yet.
async function ratesFor(day: Date): Promise<FxRates | null> {
  const res = await fetch(`${NBG_URL}&date=${day.toISOString().slice(0, 10)}`, { signal: AbortSignal.timeout(5_000) })
  if (!res.ok) throw new Error(`NBG API ${res.status}`)
  const [first] = nbgSchema.parse(await res.json())
  if (!first?.currencies.length) return null
  const rates: FxRates = { ...FALLBACK }
  for (const c of first.currencies) rates[c.code] = c.rate / c.quantity
  return rates
}

export type FxRates = Record<string, number> // GEL per 1 unit

// Used only while the National Bank cannot be reached.
const FALLBACK: FxRates = { GEL: 1, USD: 2.6, EUR: 2.9 }

let cached: { at: number; rates: FxRates } | null = null

export const fxService = {
  async latest(): Promise<FxRates> {
    if (cached && Date.now() - cached.at < TTL_MS) return cached.rates
    try {
      for (let back = 0; back < 4; back++) {
        const rates = await ratesFor(new Date(Date.now() - back * 86_400_000))
        if (rates) {
          cached = { at: Date.now(), rates }
          return rates
        }
      }
      throw new Error('NBG published no rates for the last days')
    } catch (err) {
      logger.warn('NBG rates unavailable; using fallback', errorFields(err))
      return cached?.rates ?? { ...FALLBACK }
    }
  },
}

export function toGel(amount: number | null | undefined, currency: string | null | undefined, rates: FxRates): number | null {
  if (amount === null || amount === undefined || !Number.isFinite(amount) || amount <= 0) return null
  const rate = rates[(currency ?? 'GEL').toUpperCase()]
  return rate ? amount * rate : null
}
