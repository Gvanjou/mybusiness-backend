import type { Locale } from '../../../shared/i18n/locale.js'
import type { CatalogListing } from '../../catalog/catalog.model.js'
import { catalog, financialsLevel, type CatalogSnapshot } from '../../catalog/catalog.service.js'
import { categoryLabel, cityLabel } from '../../catalog/catalog.labels.js'
import type { Profile, Track } from '../profile/profile.model.js'
import { assetClassOf, search, type Scored } from './search.tool.js'
import { listingUrl } from './cards.js'

const round = (n: number | null) => (n === null ? null : Math.round(n))

// Compact, model-facing facts about a listing. Seller text is passed separately and marked untrusted.
export function listingFacts(l: CatalogListing, s: CatalogSnapshot, locale: Locale, ref: number, scored?: Scored) {
  const stats = catalog.stats(s, l.category, l.city)
  const i = l.insights
  // Grouped by where each fact comes from, so the reply can say "the listing states", "the seller claims",
  // "by our calculation" or "not stated" — never present a claim or an estimate as a verified fact.
  return {
    ref,
    id: l.shortId,
    url: listingUrl(l, locale),
    title: l.title[locale] || l.title.en,
    from_listing: {
      category: categoryLabel(l.category, locale),
      city: cityLabel(l.city, locale) || null,
      district: l.district,
      deal_type: l.dealType,
      price_gel: round(l.priceGel),
      original_price: l.price ? `${l.price} ${l.currency ?? ''}`.trim() : l.negotiable ? 'negotiable' : 'not stated',
      area_m2: l.area,
      owner_type: l.ownerType,
      listed_on: l.createdAt?.slice(0, 10) ?? null,
    },
    seller_claims: {
      note: "The seller's own statements in the listing text, not verified by anyone",
      financials: i?.financials ?? null,
      premises: i?.premises ?? null,
      staff: i?.staff ?? null,
      years_operating: i?.yearsOperating ?? null,
      included_assets: i?.includedAssets ?? [],
      reason_for_sale: i?.reasonForSale ?? null,
      seasonality: i?.seasonality ?? null,
      location_hint: i?.locationHint ?? null,
    },
    assessment: {
      note: 'Our reading of the listing (AI analysis), not facts',
      asset_class: assetClassOf(l),
      operating_model: i?.operatingModel ?? 'unknown',
      is_operating: i?.isOperating ?? null,
      strengths: i?.strengths ?? [],
      risks: i?.risks ?? [],
      red_flags: i?.redFlags ?? [],
      summary: i?.summary[locale] ?? null,
    },
    calculated: {
      note: 'Our arithmetic over current mybusiness.ge listings',
      category_median_gel: stats?.medianGel ? round(stats.medianGel) : null,
      similar_listings: stats?.count ?? 0,
      financials_level: financialsLevel(l),
      completeness: i?.completeness ?? 0,
    },
    unknown: i?.missingInfo ?? [],
    seller_questions: i?.sellerQuestions ?? [],
    fit: scored ? { score: scored.score, reasons: scored.reasons } : undefined,
  }
}

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

// Side-by-side table for the UI; same facts go to the responder.
export function compareTable(listings: CatalogListing[], s: CatalogSnapshot, fits: Map<string, Scored>, locale: Locale) {
  const L = labelsFor(locale)
  const fmt = (n: number | null) => (n === null ? '—' : `${new Intl.NumberFormat('en-US').format(Math.round(n))} ₾`)
  const yesNo = (b: boolean | null | undefined) => (b === null || b === undefined ? '—' : b ? L.yes : L.no)
  const rows: { key: string; label: string; values: string[] }[] = [
    { key: 'price', label: L.price, values: listings.map((l) => (l.priceGel === null ? L.onRequest : fmt(l.priceGel))) },
    {
      key: 'vs_median',
      label: L.vsMedian,
      values: listings.map((l) => {
        const st = catalog.stats(s, l.category, l.city)
        if (!st?.medianGel || l.priceGel === null) return '—'
        const pct = Math.round((l.priceGel / st.medianGel - 1) * 100)
        return `${pct > 0 ? '+' : ''}${pct}%`
      }),
    },
    { key: 'city', label: L.city, values: listings.map((l) => cityLabel(l.city, locale) || '—') },
    { key: 'model', label: L.model, values: listings.map((l) => L.models[l.insights?.operatingModel ?? 'unknown']) },
    { key: 'financials', label: L.financials, values: listings.map((l) => L.fin[financialsLevel(l)]) },
    { key: 'premises', label: L.premises, values: listings.map((l) => L.tenure[l.insights?.premises.tenure ?? 'unknown'] ?? '—') },
    { key: 'staff', label: L.staff, values: listings.map((l) => (l.insights?.staff.count != null ? String(l.insights.staff.count) : '—')) },
    { key: 'staff_stays', label: L.staffStays, values: listings.map((l) => yesNo(l.insights?.staff.stays)) },
    { key: 'years', label: L.years, values: listings.map((l) => (l.insights?.yearsOperating != null ? String(l.insights.yearsOperating) : '—')) },
    { key: 'red_flags', label: L.redFlags, values: listings.map((l) => String(l.insights?.redFlags.length ?? 0)) },
    { key: 'completeness', label: L.completeness, values: listings.map((l) => `${Math.round((l.insights?.completeness ?? 0) * 100)}%`) },
    { key: 'fit', label: L.fit, values: listings.map((l) => (fits.get(l.id) ? `${Math.round(fits.get(l.id)!.score * 100)}%` : '—')) },
  ]
  return { columns: listings.map((l) => l.id), rows }
}

function labelsFor(locale: Locale) {
  const t = {
    ka: {
      price: 'ფასი', vsMedian: 'კატეგორიის მედიანასთან', city: 'ქალაქი', model: 'მართვის ფორმა', financials: 'ფინანსები',
      premises: 'ფართი', staff: 'თანამშრომლები', staffStays: 'პერსონალი რჩება', years: 'მუშაობის წლები', redFlags: 'გამაფრთხილებელი ნიშნები',
      completeness: 'ინფორმაციის სისრულე', fit: 'თქვენთან შესაბამისობა', yes: 'კი', no: 'არა', onRequest: 'შეთანხმებით',
      models: { passive: 'პასიური', semi_passive: 'ნაწილობრივ პასიური', hands_on: 'ყოველდღიური ჩართულობა', unknown: 'უცნობია' },
      fin: { stated: 'მითითებულია', vague: 'ბუნდოვანი', none: 'არ არის' },
      tenure: { owned: 'საკუთრება', leased: 'იჯარა', included_in_sale: 'შედის ფასში', unknown: 'უცნობია' } as Record<string, string>,
    },
    en: {
      price: 'Price', vsMedian: 'vs. category median', city: 'City', model: 'How it runs', financials: 'Financials',
      premises: 'Premises', staff: 'Staff', staffStays: 'Staff stays', years: 'Years operating', redFlags: 'Red flags',
      completeness: 'Information completeness', fit: 'Fit for you', yes: 'Yes', no: 'No', onRequest: 'On request',
      models: { passive: 'Passive', semi_passive: 'Semi-passive', hands_on: 'Owner daily', unknown: 'Unknown' },
      fin: { stated: 'Stated', vague: 'Vague', none: 'Not given' },
      tenure: { owned: 'Owned', leased: 'Leased', included_in_sale: 'Included', unknown: 'Unknown' } as Record<string, string>,
    },
    ru: {
      price: 'Цена', vsMedian: 'к медиане категории', city: 'Город', model: 'Формат управления', financials: 'Финансы',
      premises: 'Помещение', staff: 'Персонал', staffStays: 'Персонал остаётся', years: 'Лет работы', redFlags: 'Тревожные признаки',
      completeness: 'Полнота информации', fit: 'Подходит вам', yes: 'Да', no: 'Нет', onRequest: 'По запросу',
      models: { passive: 'Пассивный', semi_passive: 'Частично пассивный', hands_on: 'Ежедневное участие', unknown: 'Неизвестно' },
      fin: { stated: 'Указаны', vague: 'Размыто', none: 'Нет' },
      tenure: { owned: 'Собственность', leased: 'Аренда', included_in_sale: 'Входит в цену', unknown: 'Неизвестно' } as Record<string, string>,
    },
  }
  return t[locale]
}
