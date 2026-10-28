import { env } from '../../pkg/env/env.js'
import { logger, errorFields } from '../../shared/logger/logger.js'
import { sleep } from '../../shared/utils/async.js'

// OpenStreetMap address search (Nominatim): street address → coordinates. Usage policy: max 1 request/second,
// identify the app, cache results.
// https://operations.osmfoundation.org/policies/nominatim/
const MIN_INTERVAL_MS = 1_100
const CACHE_TTL_MS = 7 * 86_400_000
const TIMEOUT_MS = 6_000
const USER_AGENT = 'MyBusinessAI/0.1 (business-for-sale assistant for mybusiness.ge)'
let queue: Promise<unknown> = Promise.resolve()
let lastCall = 0

// Requests run one at a time, at least MIN_INTERVAL_MS apart, across the whole process.
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastCall + MIN_INTERVAL_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastCall = Date.now()
    return fn()
  })
  queue = run.catch(() => undefined)
  return run
}

export function distanceM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLon = toRad(bLon - aLon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

const geoCache = new Map<string, { at: number; point: { lat: number; lon: number } | null }>()

// Approximate centre of a named place ("Saburtalo, Tbilisi, Georgia"), for listings without coordinates.
export async function geocode(query: string): Promise<{ lat: number; lon: number } | null> {
  if (!env.COMPETITION_LOOKUP) return null
  const hit = geoCache.get(query)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.point
  const url = new URL('/search', env.NOMINATIM_URL)
  url.search = new URLSearchParams({ format: 'jsonv2', q: query, countrycodes: 'ge', limit: '1' }).toString()
  try {
    const res = await throttled(() => fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) }))
    if (!res.ok) throw new Error(`Nominatim ${res.status}`)
    const [first] = (await res.json()) as { lat: string; lon: string }[]
    const point = first ? { lat: Number(first.lat), lon: Number(first.lon) } : null
    geoCache.set(query, { at: Date.now(), point })
    return point
  } catch (err) {
    logger.warn('geocode failed', { query, ...errorFields(err) })
    return null
  }
}
