import type { Locale } from '../../../shared/i18n/locale.js'
import type { CatalogListing } from '../../catalog/catalog.model.js'
import { financialsLevel, type CatalogSnapshot } from '../../catalog/catalog.service.js'
import { categoryLabel, cityLabel } from '../../catalog/catalog.labels.js'
import type { Profile, Track } from '../profile/profile.model.js'
import { search, type Scored } from './search.tool.js'

// Fit of specific listings for this user, using the same scoring as search.
export function scoreListings(listings: CatalogListing[], s: CatalogSnapshot, p: Profile, track: Track): Map<string, Scored> {
  const exclude = new Set(s.listings.filter((l) => !listings.some((x) => x.id === l.id)).map((l) => l.id))
  const result = search(s, p, { track, exclude, allowProperty: true, budgetSlack: 100, ignoreCities: true })
  const all = [...result.ranked, ...(result.wildcard ? [result.wildcard] : [])]
  return new Map(all.map((r) => [r.listing.id, r]))
}

export function marketFacts(s: CatalogSnapshot, categories: string[], cities: string[], locale: Locale) {
  const sale = s.listings.filter((l) => l.dealType === 'sale')
  const cats = categories.length ? categories : [...new Set(sale.map((l) => l.category))]
  const rows = cats.flatMap((category) => {
    const cityList = cities.length ? cities : [null]
    return cityList.map((city) => {
      const items = sale.filter((l) => l.category === category && (city === null || l.city === city))
      const prices = items.map((l) => l.priceGel).filter((p): p is number => p !== null).sort((a, b) => a - b)
      const q = (x: number) => (prices.length ? Math.round(prices[Math.floor((prices.length - 1) * x)]!) : null)
      return {
        category: categoryLabel(category, locale),
        city: city ? cityLabel(city, locale) : 'all cities',
        listings: items.length,
        with_price: prices.length,
        median_gel: q(0.5),
        cheapest_gel: prices.length ? Math.round(prices[0]!) : null,
        most_expensive_gel: prices.length ? Math.round(prices[prices.length - 1]!) : null,
        with_stated_financials: items.filter((l) => financialsLevel(l) === 'stated').length,
      }
    })
  })
  return {
    as_of: s.loadedAt.toISOString().slice(0, 10),
    total_active_listings: s.listings.length,
    rows: rows.filter((r) => r.listings > 0).sort((a, b) => b.listings - a.listings).slice(0, 12),
  }
}
