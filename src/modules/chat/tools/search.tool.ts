
import { catalog, financialsLevel, type CatalogSnapshot } from '../../catalog/catalog.service.js'
import type { CatalogListing } from '../../catalog/catalog.model.js'
import { val, type Profile, type Track } from '../profile/profile.model.js'

export type ReasonCode =
  | 'FITS_BUDGET'
  | 'UNDER_BUDGET'
  | 'NEGOTIATION_NEEDED'
  | 'PRICE_ON_REQUEST'
  | 'FITS_HANDS_OFF'
  | 'HAS_MANAGER_OR_TENANT'
  | 'NEEDS_OWNER_DAILY'
  | 'MATCHES_EXPERIENCE'
  | 'IN_PREFERRED_CITY'
  | 'MATCHES_SECTOR'
  | 'MATCHES_INTEREST'
  | 'FINANCIALS_STATED'
  | 'NO_FINANCIALS'
  | 'RED_FLAGS'
  | 'BELOW_CATEGORY_MEDIAN'
  | 'ABOVE_CATEGORY_MEDIAN'
  | 'PROPERTY_NOT_BUSINESS'
  | 'PARTNERSHIP_SHARE'
  | 'WILDCARD'

export type Scored = { listing: CatalogListing; score: number; reasons: ReasonCode[] }

export type SearchResult = {
  pool: CatalogListing[] // after hard filters; the planner measures question value on this set
  ranked: Scored[]
  wildcard: Scored | null
}

const BUSINESS_CLASSES = new Set(['operating_business', 'partnership', 'other'])
const PROPERTY_CLASSES = new Set(['real_estate', 'commercial_space'])

export function assetClassOf(l: CatalogListing): string {
  if (l.insights) return l.insights.assetClass
  if (l.dealType === 'partnership') return 'partnership'
  if (l.category === 'land') return 'land'
  if (l.category === 'real_estate' || l.category === 'commercial_space') return 'real_estate'
  return 'operating_business'
}

type Weights = { budget: number; involvement: number; skills: number; risk: number; location: number; sector: number; data: number }

const weightsByTrack: Record<Track, Weights> = {
  explorer: { budget: 1, involvement: 0.6, skills: 0.4, risk: 0.6, location: 0.5, sector: 0.6, data: 0.6 },
  passive_investor: { budget: 1, involvement: 1.2, skills: 0.1, risk: 0.9, location: 0.5, sector: 0.4, data: 0.9 },
  owner_operator: { budget: 1, involvement: 0.5, skills: 1, risk: 0.5, location: 0.8, sector: 0.9, data: 0.5 },
  experienced_expander: { budget: 1, involvement: 0.4, skills: 1.2, risk: 0.5, location: 0.7, sector: 1, data: 0.6 },
  income_property_seeker: { budget: 1, involvement: 1, skills: 0.1, risk: 0.8, location: 0.8, sector: 0.3, data: 0.9 },
  specific_searcher: { budget: 1, involvement: 0.5, skills: 0.4, risk: 0.5, location: 1, sector: 1.2, data: 0.5 },
  seller: { budget: 1, involvement: 0.5, skills: 0.5, risk: 0.5, location: 0.5, sector: 0.5, data: 0.5 },
}

const involvementFit: Record<string, Record<string, number>> = {
  hands_off: { passive: 1, semi_passive: 0.6, hands_on: 0.1, unknown: 0.4 },
  part_time: { passive: 0.9, semi_passive: 1, hands_on: 0.4, unknown: 0.5 },
  full_time: { passive: 0.6, semi_passive: 0.8, hands_on: 1, unknown: 0.6 },
}

export function riskScore(l: CatalogListing): number {
  const i = l.insights
  if (!i) return 0.6
  return Math.min(1, i.redFlags.length * 0.15 + (1 - i.completeness) * 0.5)
}

function score(l: CatalogListing, p: Profile, track: Track, s: CatalogSnapshot): Scored {
  const w = weightsByTrack[track]
  const reasons: ReasonCode[] = []
  const parts: [number, number][] = [] // [weight, value 0..1]
  const budget = val(p, 'budgetGel')
  const assetClass = assetClassOf(l)

  // Budget
  if (budget) {
    if (l.priceGel === null) {
      parts.push([w.budget, 0.4])
      reasons.push('PRICE_ON_REQUEST')
    } else {
      const ratio = l.priceGel / budget
      if (ratio <= 1 && ratio >= 0.45) {
        parts.push([w.budget, 1])
        reasons.push('FITS_BUDGET')
      } else if (ratio < 0.45) {
        parts.push([w.budget, 0.6])
        reasons.push('UNDER_BUDGET')
      } else {
        parts.push([w.budget, 0.45])
        reasons.push('NEGOTIATION_NEEDED')
      }
    }
  }

  // Involvement vs. how the business runs
  const involvement = val(p, 'involvement')
  const model = l.insights?.operatingModel ?? 'unknown'
  if (involvement) {
    const fit = involvementFit[involvement]?.[model] ?? 0.5
    parts.push([w.involvement, fit])
    if (involvement === 'hands_off' && model === 'passive') reasons.push(PROPERTY_CLASSES.has(assetClass) ? 'HAS_MANAGER_OR_TENANT' : 'FITS_HANDS_OFF')
    if (involvement !== 'full_time' && model === 'hands_on') reasons.push('NEEDS_OWNER_DAILY')
  }

  // Skills / experience
  const expSectors = val(p, 'experienceSectors') ?? []
  if (expSectors.includes(l.category)) {
    parts.push([w.skills, 1])
    reasons.push('MATCHES_EXPERIENCE')
  } else if (val(p, 'experience') === 'none' && model === 'hands_on') {
    parts.push([w.skills, 0.4])
  } else if (val(p, 'experience')) {
    parts.push([w.skills, 0.6])
  }

  // Risk tolerance vs. how much is unknown or flagged
  const risk = riskScore(l)
  const tolerance = val(p, 'risk') ?? 'medium'
  parts.push([w.risk, tolerance === 'low' ? 1 - risk : tolerance === 'medium' ? 1 - risk / 2 : 0.8])
  if ((l.insights?.redFlags.length ?? 0) >= 2) reasons.push('RED_FLAGS')

  // Location
  const cities = val(p, 'cities') ?? []
  if (cities.length) {
    const inCity = l.city !== null && cities.includes(l.city)
    parts.push([w.location, inCity ? 1 : 0.4])
    if (inCity) reasons.push('IN_PREFERRED_CITY')
  }

  // Sector
  const sectors = val(p, 'sectors') ?? []
  let sectorValue = sectors.length ? (sectors.includes(l.category) ? 1 : 0.35) : 0.6
  if (sectors.includes(l.category)) reasons.push('MATCHES_SECTOR')
  parts.push([w.sector, sectorValue])

  // How much can actually be evaluated
  parts.push([w.data, l.insights?.completeness ?? 0.2])
  const fin = financialsLevel(l)
  reasons.push(fin === 'stated' ? 'FINANCIALS_STATED' : 'NO_FINANCIALS')

  // Price vs. similar listings
  const stats = catalog.stats(s, l.category, l.city)
  if (l.priceGel !== null && stats?.medianGel && stats.count >= 4) {
    if (l.priceGel < stats.medianGel * 0.75) reasons.push('BELOW_CATEGORY_MEDIAN')
    if (l.priceGel > stats.medianGel * 1.5) reasons.push('ABOVE_CATEGORY_MEDIAN')
  }

  if (PROPERTY_CLASSES.has(assetClass)) reasons.push('PROPERTY_NOT_BUSINESS')
  if (assetClass === 'partnership') reasons.push('PARTNERSHIP_SHARE')

  const total = parts.reduce((a, [wt]) => a + wt, 0)
  const value = total === 0 ? 0.5 : parts.reduce((a, [wt, v]) => a + wt * v, 0) / total
  return { listing: l, score: Math.round(value * 1000) / 1000, reasons }
}

export type SearchOptions = {
  track: Track
  exclude?: Set<string>
  strictSectors?: boolean
  budgetSlack?: number
  ignoreCities?: boolean
  allowProperty?: boolean
}

// Hard filters: things that make a listing irrelevant regardless of score.
export function filterPool(s: CatalogSnapshot, p: Profile, o: SearchOptions): CatalogListing[] {
  const budget = val(p, 'budgetGel')
  const slack = o.budgetSlack ?? 1.15
  const cities = val(p, 'cities') ?? []
  const flexible = val(p, 'locationFlexible') === true
  const sectors = val(p, 'sectors') ?? []
  const exclusions = new Set(val(p, 'sectorExclusions') ?? [])
  const wantsLand = sectors.includes('land')
  const allowProperty =
    o.allowProperty ?? (val(p, 'assetOpenness') === 'open_to_property' || o.track === 'income_property_seeker' || sectors.some((x) => x === 'real_estate' || x === 'commercial_space'))

  return s.listings.filter((l) => {
    if (o.exclude?.has(l.id)) return false
    if (l.dealType === 'lease') return false
    const cls = assetClassOf(l)
    if (cls === 'land' && !wantsLand) return false
    if (PROPERTY_CLASSES.has(cls) && !allowProperty) return false
    if (!BUSINESS_CLASSES.has(cls) && !PROPERTY_CLASSES.has(cls) && cls !== 'land') return false
    if (exclusions.has(l.category)) return false
    if (budget && l.priceGel !== null && l.priceGel > budget * slack) return false
    if (budget && l.priceGel !== null && l.priceGel < budget * 0.05) return false
    if (!o.ignoreCities && cities.length && !flexible && (l.city === null || !cities.includes(l.city))) return false
    if (o.strictSectors && sectors.length && !sectors.includes(l.category)) return false
    return true
  })
}

function dedupe(items: Scored[]): Scored[] {
  const seen = new Set<string>()
  return items.filter((x) => {
    const key = `${x.listing.title.en.toLowerCase()}|${x.listing.priceGel ?? 'x'}|${x.listing.city ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function search(s: CatalogSnapshot, p: Profile, o: SearchOptions): SearchResult {
  const pool = filterPool(s, p, o)
  const ranked = dedupe(pool.map((l) => score(l, p, o.track, s)).sort((a, b) => b.score - a.score))

  // When the user named sectors and enough listings match, show those first;
  // keep one strong listing from another sector as the "you might not have considered" pick.
  const sectors = val(p, 'sectors') ?? []
  let main = ranked
  let wildcard: Scored | null = null
  if (sectors.length) {
    const inSector = ranked.filter((r) => sectors.includes(r.listing.category))
    const outside = ranked.filter((r) => !sectors.includes(r.listing.category))
    if (inSector.length >= 2) {
      main = inSector
      const best = outside[0]
      if (best && inSector[0] && best.score >= inSector[0].score * 0.9) wildcard = best
    }
  } else if (ranked.length > 3) {
    const topCategories = new Set(ranked.slice(0, 3).map((r) => r.listing.category))
    const best = ranked.slice(3).find((r) => !topCategories.has(r.listing.category))
    if (best && ranked[0] && best.score >= ranked[0].score * 0.85) wildcard = best
  }
  if (wildcard) wildcard = { ...wildcard, reasons: ['WILDCARD', ...wildcard.reasons] }
  return { pool, ranked: main.filter((r) => r.listing.id !== wildcard?.listing.id), wildcard }
}

// Concrete ways to widen an empty or tiny result set, with how many listings each would add.
export function relaxations(s: CatalogSnapshot, p: Profile, o: SearchOptions, currentCount: number) {
  const out: { kind: 'budget_up' | 'any_city' | 'include_property' | 'any_sector'; extra: number }[] = []
  const count = (opts: Partial<SearchOptions>) => filterPool(s, p, { ...o, ...opts }).length - currentCount
  if (val(p, 'budgetGel')) out.push({ kind: 'budget_up', extra: count({ budgetSlack: 1.4 }) })
  if ((val(p, 'cities') ?? []).length) out.push({ kind: 'any_city', extra: count({ ignoreCities: true }) })
  if (val(p, 'assetOpenness') !== 'open_to_property') out.push({ kind: 'include_property', extra: count({ allowProperty: true }) })
  if (o.strictSectors) out.push({ kind: 'any_sector', extra: count({ strictSectors: false }) })
  return out.filter((r) => r.extra > 0).sort((a, b) => b.extra - a.extra)
}
