import { logger, errorFields } from '../../shared/logger/logger.js'
import { fxService, toGel, type FxRates } from '../fx/fx.service.js'
import { siteListing, siteListings, type SiteListing } from '../live/live.service.js'
import type { CatalogListing, CategoryStats, FinancialsLevel } from './catalog.model.js'
import { textInsights, type SiteFields } from './catalog.text.js'

// The listings on mybusiness.ge, read live from the site and held in memory only. A snapshot older than
// FRESH_MS is re-read on the next question; if the site does not answer, the last one keeps serving.
const FRESH_MS = 3 * 60_000
const MAX_DETAILS = 12

type Snapshot = {
  listings: CatalogListing[]
  byId: Map<string, CatalogListing>
  byShortId: Map<string, CatalogListing>
  stats: Map<string, CategoryStats> // key: `${category}|${city ?? '*'}`
  cities: string[]
  categories: string[]
  rates: FxRates
  loadedAt: Date
}

let snapshot: Snapshot | null = null
let loading: Promise<Snapshot> | null = null

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

function buildStats(listings: CatalogListing[]): Map<string, CategoryStats> {
  const groups = new Map<string, number[]>()
  const counts = new Map<string, number>()
  for (const l of listings) {
    if (l.dealType !== 'sale') continue
    for (const key of [`${l.category}|${l.city ?? '*'}`, `${l.category}|*`]) {
      counts.set(key, (counts.get(key) ?? 0) + 1)
      if (l.priceGel !== null) {
        const arr = groups.get(key) ?? []
        arr.push(l.priceGel)
        groups.set(key, arr)
      }
    }
  }
  const stats = new Map<string, CategoryStats>()
  for (const [key, count] of counts) {
    const prices = (groups.get(key) ?? []).sort((a, b) => a - b)
    stats.set(key, { count, medianGel: quantile(prices, 0.5), p25Gel: quantile(prices, 0.25), p75Gel: quantile(prices, 0.75) })
  }
  return stats
}

type Row = Record<string, unknown>

export function toListing(r: Row, rates: FxRates): CatalogListing {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null)
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
  const arr = (v: unknown) => (Array.isArray(v) ? (v as string[]) : [])
  const title = String(r.title)
  // The site's own structured fields; they fill gaps in what the text says.
  const site: SiteFields = {
    employees: num(r.employees),
    yearEstablished: num(r.year_established),
    revenueMonthly: num(r.monthly_revenue),
    incomeMonthly: num(r.monthly_income),
    currency: str(r.currency),
  }
  const latitude = num(r.latitude)
  return {
    id: String(r.id),
    shortId: String(r.short_id ?? String(r.id).slice(0, 8)),
    title: { ka: str(r.title_ka) ?? title, en: str(r.title_en) ?? title, ru: str(r.title_ru) ?? title },
    category: String(r.category),
    dealType: String(r.deal_type),
    price: num(r.price),
    currency: str(r.currency),
    priceGel: toGel(num(r.price), str(r.currency), rates),
    negotiable: Boolean(r.price_negotiable),
    city: str(r.city),
    district: str(r.district),
    area: num(r.area),
    ownerType: str(r.owner_type),
    coverImage: str(r.cover_image_url),
    images: (arr(r.image_urls).length ? arr(r.image_urls) : Array.isArray(r.business_images) ? (r.business_images as { image_url: string }[]).map((x) => x.image_url) : []).slice(0, 8),
    createdAt: str(r.source_created_at ?? r.created_at),
    address: str(r.address),
    latitude,
    longitude: num(r.longitude),
    description: { original: str(r.description) ?? '', en: str(r.description_en) },
    // The seller's own facts, read from the listing text by rules (no model call, nothing stored).
    insights: textInsights({
      category: String(r.category),
      dealType: String(r.deal_type),
      texts: [str(r.description_ka), str(r.description_en), str(r.description)].filter((x): x is string => x !== null),
      site,
      hasLocation: latitude !== null || str(r.address) !== null || str(r.district) !== null,
      priceKnown: num(r.price) !== null && Number(r.price) > 0,
    }),
    detailed: typeof r.description === 'string' || typeof r.description_ka === 'string',
  }
}

function build(listings: CatalogListing[], rates: FxRates): Snapshot {
  return {
    listings,
    byId: new Map(listings.map((l) => [l.id, l])),
    byShortId: new Map(listings.map((l) => [l.shortId, l])),
    stats: buildStats(listings),
    cities: [...new Set(listings.map((l) => l.city).filter((c): c is string => c !== null))].sort(),
    categories: [...new Set(listings.map((l) => l.category))].sort(),
    rates,
    loadedAt: new Date(),
  }
}

async function load(): Promise<Snapshot> {
  const started = Date.now()
  const [rates, raw] = await Promise.all([fxService.latest(), siteListings()])
  if (raw.length === 0) throw new Error('mybusiness.ge returned no listings')
  // Details already read stay (the list endpoint has no description, address or coordinates).
  const listings = raw.map((r) => {
    const known = snapshot?.byId.get(String(r.id))
    return known?.detailed ? known : toListing(r as Row, rates)
  })
  logger.info('listings read from mybusiness.ge', { listings: listings.length, ms: Date.now() - started })
  return build(listings, rates)
}

export const catalog = {
  async reload(): Promise<Snapshot> {
    if (!loading) {
      loading = load()
        .then((s) => (snapshot = s))
        .finally(() => (loading = null))
    }
    return loading
  },

  // The listings as the site shows them now (at most FRESH_MS old).
  async get(): Promise<Snapshot> {
    if (snapshot && Date.now() - snapshot.loadedAt.getTime() < FRESH_MS) return snapshot
    if (!snapshot) return this.reload()
    const last = snapshot
    return this.reload().catch((err) => {
      logger.warn('mybusiness.ge not reachable; using the listings read last', errorFields(err))
      return last
    })
  },

  // Full details (description, address, coordinates, figures) for the listings about to be shown or analysed.
  // Listings the site no longer has are dropped from the returned snapshot.
  async withDetails(s: Snapshot, ids: string[]): Promise<Snapshot> {
    const todo = [...new Set(ids)].filter((id) => !s.byId.get(id)?.detailed).slice(0, MAX_DETAILS)
    if (todo.length === 0) return s
    const results = await Promise.allSettled(todo.map((id) => siteListing(id)))
    const upsert: CatalogListing[] = []
    const gone = new Set<string>()
    results.forEach((r, i) => {
      if (r.status === 'rejected') return // site slow: keep what the list said
      if (r.value === null) gone.add(todo[i]!)
      else upsert.push(toListing(r.value as Row, s.rates))
    })
    const next = withListings(s, upsert, gone)
    // Later questions in the next minutes reuse the details.
    if (snapshot === s) snapshot = next
    return next
  },

  // One listing read from the site now, by id, short id or URL. null = removed, sold or expired.
  async fetch(s: Snapshot, ref: string): Promise<{ snapshot: Snapshot; listing: CatalogListing } | null | 'unavailable'> {
    const key = ref.toLowerCase().match(/[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?/)?.[0]
    if (!key) return 'unavailable'
    const id = key.length > 8 ? key : s.byShortId.get(key)?.id
    if (!id) return 'unavailable'
    let raw: SiteListing | null
    try {
      raw = await siteListing(id)
    } catch {
      const known = s.byId.get(id)
      return known ? { snapshot: s, listing: known } : 'unavailable'
    }
    if (!raw) return null
    const listing = toListing(raw as Row, s.rates)
    return { snapshot: withListings(s, [listing]), listing }
  },

  // Accepts a full UUID, an 8-char short id, or a mybusiness.ge listing URL.
  resolve(s: Snapshot, ref: string): CatalogListing | undefined {
    const match = ref.toLowerCase().match(/[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?/)
    if (!match) return undefined
    const key = match[0]
    return key.length > 8 ? s.byId.get(key) : s.byShortId.get(key)
  },

  stats(s: Snapshot, category: string, city: string | null): CategoryStats | undefined {
    const local = s.stats.get(`${category}|${city ?? '*'}`)
    if (local && local.count >= 3) return local
    return s.stats.get(`${category}|*`)
  },
}

// A copy of the snapshot with some listings replaced or added and others removed (live data for one turn).
// Market statistics stay those of the full catalogue.
export function withListings(s: Snapshot, upsert: CatalogListing[], remove: Set<string> = new Set()): Snapshot {
  if (upsert.length === 0 && remove.size === 0) return s
  const fresh = new Map(upsert.map((l) => [l.id, l]))
  const listings = [...s.listings.filter((l) => !remove.has(l.id) && !fresh.has(l.id)), ...fresh.values()]
  return {
    ...s,
    listings,
    byId: new Map(listings.map((l) => [l.id, l])),
    byShortId: new Map(listings.map((l) => [l.shortId, l])),
    cities: [...new Set([...s.cities, ...upsert.map((l) => l.city).filter((c): c is string => c !== null)])].sort(),
  }
}

// The floor area: the site's own field, else what the seller wrote in the text ("21 კვ.მ").
export function areaOf(l: CatalogListing): number | null {
  return l.area ?? l.insights?.premises.area_m2 ?? null
}

// Listings to judge a price against: the same kind of business, in the same city when there are enough, and of a
// similar size when the area is known — a 15 m² kiosk is never measured against 300 m² restaurants: with too few
// listings of its size there is no comparison at all (an empty pool), not a comparison with every size.
export function peerPool(l: CatalogListing, s: Snapshot, min = 3): { pool: CatalogListing[]; inCity: boolean; sized: [number, number] | null } {
  const same = s.listings.filter((x) => x.id !== l.id && x.dealType === l.dealType && x.category === l.category && x.priceGel !== null)
  const local = same.filter((x) => x.city === l.city)
  const inCity = local.length >= min
  const pool = inCity ? local : same
  const area = areaOf(l)
  if (!area || area < 5) return { pool, inCity, sized: null }
  const lo = Math.round(area * 0.5)
  const hi = Math.round(area * 2)
  const ofSize = (xs: CatalogListing[]) => xs.filter((x) => {
    const a = areaOf(x)
    return a !== null && a >= lo && a <= hi
  })
  const localSized = ofSize(local)
  if (localSized.length >= min) return { pool: localSized, inCity: true, sized: [lo, hi] }
  const anySized = ofSize(same)
  return { pool: anySized.length >= min ? anySized : [], inCity: false, sized: [lo, hi] }
}

export function financialsLevel(l: CatalogListing): FinancialsLevel {
  const f = l.insights?.financials
  if (f && (f.revenue_monthly || f.profit_monthly || f.rent_income_monthly)) return 'stated'
  if (l.insights?.redFlags.some((r) => /income|revenue|profit|figures/i.test(r))) return 'vague'
  return 'none'
}

export type { Snapshot as CatalogSnapshot }
