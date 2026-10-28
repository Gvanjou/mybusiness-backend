import { pick, type Locale } from '../../shared/i18n/locale.js'
import type { CatalogListing } from '../catalog/catalog.model.js'
import type { CatalogSnapshot } from '../catalog/catalog.service.js'
import { competitionConfig, type Scope } from './competition.config.js'
import { C } from './competition.labels.js'
import { type Busy, type Verdict } from './location.service.js'

export type CompetitionLevel = 'low' | 'medium' | 'high' | 'unknown'

export type CompetitionSection = {
  title: string
  nearbyCount: number | null
  typeLabel: string
  radiusM: number
  forSaleCity: number
  scope: Scope
  scopeText: string
  level: CompetitionLevel
  levelLabel: string
  stats: { label: string; value: string }[]
  nearest: { name: string; distance: string }[]
  notes: string[]
  risks: { level: 'high' | 'medium' | 'low'; text: string }[]
  verdict: { key: Verdict; title: string; text: string }
  activity: { total: number; busy: Busy } | null
}

const fill = (text: string, vars: Record<string, string | number>) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), text)

// Similar businesses for sale on mybusiness.ge in the same city / district (no network needed).
export function marketSupply(l: CatalogListing, s: CatalogSnapshot, category = l.category) {
  const same = s.listings.filter((x) => x.id !== l.id && x.dealType !== 'lease' && x.category === category)
  return {
    city: l.city ? same.filter((x) => x.city === l.city).length : 0,
    district: l.district ? same.filter((x) => x.city === l.city && x.district === l.district).length : null,
  }
}

// Quick, offline snapshot for recommendation lists: scope + market supply.
export function competitionSnapshot(l: CatalogListing, s: CatalogSnapshot, locale: Locale) {
  const cfg = competitionConfig(l.category)
  const supply = marketSupply(l, s)
  return { scope: cfg.scope, similar_for_sale_in_city: supply.city, scope_text: fill(pick(C.scope[cfg.scope], locale), { r: cfg.radiusM ?? 500 }) }
}

export function competitionQuestion(category: string, locale: Locale): string | null {
  return competitionConfig(category).scope === 'hyperlocal' ? pick(C.question, locale) : null
}
