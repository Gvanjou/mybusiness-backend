import { pick, type Locale } from '../../shared/i18n/locale.js'
import type { CatalogListing } from '../catalog/catalog.model.js'
import type { CatalogSnapshot } from '../catalog/catalog.service.js'
import { LOC } from './location.labels.js'

// Commercial space: which listings are spaces a business could open in, and the rent such a space earns.

export type Busy = 'busy' | 'moderate' | 'quiet'
export type Verdict = 'favourable' | 'workable' | 'tough' | 'weak_demand' | 'unknown'
export const PROPERTY_CATEGORIES = ['commercial_space', 'real_estate', 'offices', 'warehouse']

// A space someone could open a business in (not a flat or a house for living in).
export function isCommercialSpace(l: CatalogListing): boolean {
  if (!PROPERTY_CATEGORIES.includes(l.category)) return false
  if (l.category !== 'real_estate') return true
  const text = `${l.title.ka ?? ''} ${l.title.en ?? ''} ${l.title.ru ?? ''}`
  return !/ბინა|ბინის|საცხოვრებ|კერძო სახლ|აგარაკ|apartment|\bflat\b|residential|house|villa|квартир|жил(ой|ая|ое)|дом\b|дача|вилл/i.test(text) || /კომერციულ|commercial|коммерческ/i.test(text)
}

export type Point = { lat: number; lon: number; approx: string | null }

// Rent per m² from lease listings of spaces in the same city → monthly rent and gross yield for this space.
export function rentBenchmark(l: CatalogListing, s: CatalogSnapshot) {
  const leases = s.listings.filter(
    (x) => x.dealType === 'lease' && x.city === l.city && [...PROPERTY_CATEGORIES, 'retail'].includes(x.category) && x.priceGel && x.area && x.area >= 15,
  )
  const perM2 = leases.map((x) => x.priceGel! / x.area!).filter((v) => v >= 3 && v <= 300).sort((a, b) => a - b)
  if (perM2.length < 2 || !l.area || !l.priceGel || l.dealType === 'lease') return null
  const median = perM2[Math.floor(perM2.length / 2)]!
  const monthly = median * l.area
  return { rentPerM2: Math.round(median), monthly: Math.round(monthly), yieldPct: Math.round(((monthly * 12) / l.priceGel) * 1000) / 10, sample: perM2.length }
}

const fill = (text: string, vars: Record<string, string | number>) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), text)

export function scanChip(l: CatalogListing, locale: Locale) {
  return { kind: 'message' as const, id: 'scan', label: pick(LOC.scanChip, locale), text: fill(pick(LOC.scanChipText, locale), { id: l.shortId }) }
}
