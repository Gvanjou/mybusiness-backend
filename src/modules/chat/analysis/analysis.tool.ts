import { formatGel, pick, type Locale } from '../../../shared/i18n/locale.js'
import { categoryLabel, cityLabel } from '../../catalog/catalog.labels.js'
import type { CatalogListing } from '../../catalog/catalog.model.js'
import { financialsLevel, type CatalogSnapshot } from '../../catalog/catalog.service.js'
import type { Profile, Track } from '../profile/profile.model.js'
import type { Aspect } from '../router/router.schema.js'
import { toCard, type ListingCard } from '../tools/cards.js'
import { assetClassOf } from '../tools/search.tool.js'
import { scoreListings } from '../tools/facts.tool.js'
import { A } from './analysis.labels.js'
import { competitionQuestion, type CompetitionSection } from '../../competition/competition.service.js'
import { listingUrl } from '../tools/cards.js'

// Deep, deterministic analysis of one listing: where its price sits in the market, how it compares with
// similar listings, what is missing, what could go wrong and what to ask the seller. Works without AI;
// with AI the responder explains these numbers.

type Level = 'high' | 'medium' | 'low'
type RiskKey = keyof typeof A.risks

export type ListingAnalysis = {
  listingId: string
  aspect: Aspect
  financials?: 'stated' | 'vague' | 'none'
  price?: {
    title: string
    value: string
    position: 'below' | 'typical' | 'above' | 'unknown'
    verdictLabel: string
    verdict: string
    stats: { label: string; value: string }[]
    band?: { min: number; p25: number; median: number; p75: number; max: number; value: number }
    sample: string
    sampleSize: number
    diffPct: number
    perM2?: { own: string; median: string }
    payback?: string
  }
  risks?: { title: string; items: { level: Level; text: string }[] }
  completeness?: { title: string; score: string; pct: number; items: { label: string; present: boolean }[] }
  questions?: { title: string; items: string[]; draftTitle: string; draft: string; listingUrl: string; contactLabel: string }
  competition?: CompetitionSection
  comparables?: { title: string; cards: ListingCard[] }
}

const fill = (text: string, vars: Record<string, string | number>) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), text)
const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))]!
const DAY = 86_400_000

// Same category (same city first), price in a comparable range.
function comparables(l: CatalogListing, s: CatalogSnapshot): CatalogListing[] {
  if (l.priceGel === null) return []
  const self = l.priceGel
  const pool = s.listings.filter((x) => x.id !== l.id && x.dealType !== 'lease' && x.priceGel !== null && x.priceGel / self > 0.4 && x.priceGel / self < 2.5)
  const sameCat = pool.filter((x) => x.category === l.category)
  const base = sameCat.length >= 2 ? sameCat : pool.filter((x) => assetClassOf(x) === assetClassOf(l))
  return base
    .map((x) => ({ x, d: Math.abs(Math.log(x.priceGel! / self)) + (x.city === l.city ? 0 : 0.35) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 4)
    .map((r) => r.x)
}

// Price distribution of the listing's category (city if enough listings, else all cities).
function market(l: CatalogListing, s: CatalogSnapshot) {
  const sale = s.listings.filter((x) => x.dealType !== 'lease' && x.category === l.category && x.priceGel !== null && x.id !== l.id)
  const local = sale.filter((x) => x.city === l.city)
  const useLocal = local.length >= 4
  const set = (useLocal ? local : sale).map((x) => x.priceGel!).sort((a, b) => a - b)
  return { prices: set, local: useLocal }
}

// Price per m², only when the area and the result are plausible: sellers sometimes enter the land plot
// or a typo as the area, and a "3 ₾ per m²" restaurant must not become a confident conclusion.
function pricePerM2(l: CatalogListing): number | null {
  if (l.priceGel === null || !l.area || l.area < 5 || l.area > 20_000) return null
  const v = l.priceGel / l.area
  return v >= 100 && v <= 100_000 ? v : null
}

export function analyzeListing(p: {
  listing: CatalogListing
  snapshot: CatalogSnapshot
  profile: Profile
  track: Track
  locale: Locale
  aspect: Aspect
}): { analysis: ListingAnalysis; facts: Record<string, unknown> } {
  const { listing: l, snapshot: s, locale, aspect } = p
  const tr = (x: Parameters<typeof pick>[0]) => pick(x, locale)
  const i = l.insights
  const fin = financialsLevel(l)
  const assetClass = assetClassOf(l)
  const cat = categoryLabel(l.category, locale)
  const city = cityLabel(l.city, locale)

  // ── Price ──
  const m = market(l, s)
  let position: 'below' | 'typical' | 'above' | 'unknown' = 'unknown'
  let diffPct = 0
  let band: NonNullable<ListingAnalysis['price']>['band']
  if (l.priceGel !== null && m.prices.length >= 4) {
    const p25 = quantile(m.prices, 0.25)
    const median = quantile(m.prices, 0.5)
    const p75 = quantile(m.prices, 0.75)
    diffPct = Math.round((l.priceGel / median - 1) * 100)
    position = l.priceGel < p25 ? 'below' : l.priceGel > p75 ? 'above' : 'typical'
    band = { min: m.prices[0]!, p25, median, p75, max: m.prices[m.prices.length - 1]!, value: l.priceGel }
  }
  const comps = comparables(l, s)
  const perM2 = pricePerM2(l)
  const compPerM2 = comps.map(pricePerM2).filter((x): x is number => x !== null).sort((a, b) => a - b)
  const compM2Median = compPerM2.length >= 2 ? quantile(compPerM2, 0.5) : null
  const m2Ratio = perM2 && compM2Median ? perM2 / compM2Median : null
  const m2Note =
    m2Ratio && compM2Median && perM2
      ? m2Ratio >= 1.5
        ? fill(pick(A.price.perM2High, locale), { own: formatGel(perM2, locale), median: formatGel(compM2Median, locale), x: m2Ratio.toFixed(1) })
        : m2Ratio <= 0.67
          ? fill(pick(A.price.perM2Low, locale), { own: formatGel(perM2, locale), median: formatGel(compM2Median, locale) })
          : null
      : null
  const profit = i?.financials.profit_monthly ?? i?.financials.rent_income_monthly
  const profitGel = profit ? ((profit.min + profit.max) / 2) * (s.rates[profit.currency] ?? 1) : null
  const verdict =
    l.priceGel === null
      ? tr(A.price.onRequest)
      : position === 'below'
        ? fill(tr(A.price.verdictBelow), { pct: Math.abs(diffPct) })
        : position === 'above'
          ? fill(tr(A.price.verdictAbove), { pct: diffPct })
          : position === 'typical'
            ? fill(tr(A.price.verdictTypical), { diff: `${diffPct > 0 ? '+' : ''}${diffPct}%` })
            : tr(A.price.unknown)
  const price: ListingAnalysis['price'] = {
    title: tr(A.sections.price),
    value: l.priceGel !== null ? formatGel(l.priceGel, locale) : '—',
    position,
    verdictLabel: tr(A.price[position]),
    verdict: m2Note ? `${verdict} ${m2Note}` : verdict,
    stats: [
      { label: tr(A.price.listing), value: l.priceGel !== null ? formatGel(l.priceGel, locale) : '—' },
      ...(band ? [{ label: tr(A.price.median), value: formatGel(band.median, locale) }, { label: tr(A.price.range), value: `${formatGel(band.p25, locale)} – ${formatGel(band.p75, locale)}` }] : []),
      ...(perM2 ? [{ label: tr(A.price.perM2), value: formatGel(perM2, locale) }] : []),
      ...(compPerM2.length >= 2 ? [{ label: tr(A.price.perM2Median), value: formatGel(quantile(compPerM2, 0.5), locale) }] : []),
    ],
    band,
    sample: fill(tr(A.price.sample), { n: m.prices.length, scope: fill(tr(m.local ? A.price.scopeCity : A.price.scopeAll), { cat, city }) }),
    sampleSize: m.prices.length,
    diffPct,
    perM2: perM2 && compM2Median ? { own: formatGel(perM2, locale), median: formatGel(compM2Median, locale) } : undefined,
    payback:
      l.priceGel !== null && profitGel && profitGel > 0
        ? fill(tr(A.price.payback), { profit: formatGel(profitGel, locale), years: (l.priceGel / (profitGel * 12)).toFixed(1) })
        : assetClass === 'operating_business' || assetClass === 'partnership'
          ? tr(A.price.noProfit)
          : undefined,
  }

  // ── Completeness ──
  const has = {
    price: l.priceGel !== null,
    revenue: Boolean(i?.financials.revenue_monthly),
    profit: Boolean(i?.financials.profit_monthly || i?.financials.rent_income_monthly),
    lease: Boolean(i && i.premises.tenure !== 'unknown'),
    rent: Boolean(i?.premises.rent_monthly) || i?.premises.tenure === 'owned',
    staff: i?.staff.count != null,
    years: i?.yearsOperating != null,
    location: Boolean(i?.locationHint || l.district || l.latitude !== null),
    reason: Boolean(i?.reasonForSale),
    area: Boolean(l.area || i?.premises.area_m2),
  }
  const applicable = (Object.keys(has) as (keyof typeof has)[]).filter((k) => assetClass !== 'land' || ['price', 'location', 'area'].includes(k))
  const presentCount = applicable.filter((k) => has[k]).length
  const completeness: ListingAnalysis['completeness'] = {
    title: tr(A.sections.completeness),
    score: fill(tr(A.completeness.score), { pct: Math.round((presentCount / applicable.length) * 100) }),
    pct: Math.round((presentCount / applicable.length) * 100),
    items: applicable.map((k) => ({ label: tr(A.completeness.items[k]), present: has[k] })),
  }

  // ── Risks ──
  const risks: { key: RiskKey; level: Level; vars?: Record<string, string | number> }[] = []
  if (assetClass === 'land') risks.push({ key: 'land', level: 'medium' })
  if (l.priceGel === null) risks.push({ key: 'price_on_request', level: 'medium' })
  if (assetClass !== 'land') {
    if (fin === 'vague') risks.push({ key: 'vague_income', level: 'high' })
    else if (fin === 'none') risks.push({ key: i?.highlights?.onRequest || i?.financials.other_figures.some((x) => /on request/i.test(x)) ? 'financials_on_request' : 'no_financials', level: 'high' })
  }
  if (position === 'above' && diffPct >= 25) risks.push({ key: 'above_market', level: 'medium', vars: { pct: diffPct } })
  if (band && l.priceGel !== null && l.priceGel < band.median * 0.5) risks.push({ key: 'far_below', level: 'medium', vars: { pct: Math.abs(diffPct) } })
  if (assetClass === 'operating_business' && !has.lease) risks.push({ key: 'lease_unknown', level: 'medium' })
  if (m2Ratio && m2Ratio >= 1.5) risks.push({ key: 'per_m2_high', level: 'medium', vars: { x: m2Ratio.toFixed(1) } })
  if ((i?.redFlags.length ?? 0) >= 2) risks.push({ key: 'seller_flags', level: 'medium', vars: { n: i!.redFlags.length } })
  if (['hotels', 'tourism'].includes(l.category) || i?.seasonality) risks.push({ key: 'seasonal', level: 'medium' })
  if (!has.location) risks.push({ key: 'no_location', level: 'low' })
  if (i?.operatingModel === 'hands_on') risks.push({ key: 'owner_daily', level: 'low' })
  if (l.ownerType === 'agency' || l.ownerType === 'broker') risks.push({ key: 'intermediary', level: 'low' })
  const days = l.createdAt ? Math.floor((Date.now() - new Date(l.createdAt).getTime()) / DAY) : 0
  if (days > 120) risks.push({ key: 'old_listing', level: 'low', vars: { days } })
  const order: Record<Level, number> = { high: 0, medium: 1, low: 2 }
  risks.sort((a, b) => order[a.level] - order[b.level])

  // ── Questions: the gaps first, then what matters for this kind of business ──
  const q = A.questions
  const gapQuestions = [
    !has.revenue && q.revenue,
    !has.profit && q.profit,
    !has.lease && q.lease,
    !has.location && q.address,
    !has.reason && q.reason,
    !has.staff && q.staff,
    !has.years && q.years,
  ].filter(Boolean) as (typeof q.revenue)[]
  const catQuestion =
    assetClass === 'land'
      ? q.land
      : ['restaurants', 'bakery', 'bar_nightclub', 'food_products'].includes(l.category)
        ? q.food
        : ['hotels', 'tourism'].includes(l.category)
          ? q.hotel
          : ['retail', 'supermarket', 'clothing_store'].includes(l.category)
            ? q.retail
            : ['online', 'e_commerce'].includes(l.category)
              ? q.online
              : ['manufacturing', 'winery', 'agriculture'].includes(l.category)
                ? q.production
                : ['car_service', 'car_wash', 'auto_business'].includes(l.category)
                  ? q.auto
                  : null
  const ordered = [...gapQuestions, ...(catQuestion ? [catQuestion] : []), q.tax, q.included]
  const compQ = competitionQuestion(l.category, locale)
  const questionItems = [...new Set([...ordered.map(tr).slice(0, 5), ...(compQ ? [compQ] : []), ...ordered.map(tr).slice(5)])].slice(0, 7)
  const title = pick(l.title, locale)
  const questions: ListingAnalysis['questions'] = {
    title: tr(A.sections.questions),
    items: questionItems,
    draftTitle: tr(A.sections.draft),
    listingUrl: listingUrl(l, locale),
    contactLabel: tr(A.sections.contact),
    // The message names the missing topics briefly instead of pasting full questions.
    draft: fill(tr(q.draft), { title, items: applicable.filter((k) => !has[k] && k !== 'price').slice(0, 5).map((k) => tr(A.completeness.items[k]).toLowerCase()).join(', ') || tr(q.included).toLowerCase() }),
  }

  // ── Comparables as cards, scored for this buyer ──
  const fits = scoreListings(comps, s, p.profile, p.track)
  const compCards = comps.map((c) => toCard(c, locale, fits.get(c.id), s.rates.USD))

  const sections: Record<Aspect, (keyof ListingAnalysis)[]> = {
    overview: ['price', 'risks', 'completeness'],
    price: ['price', 'comparables'],
    risks: ['risks', 'completeness'],
    competition: [],
    missing: ['completeness', 'questions'],
    seller_questions: ['questions'],
    similar: ['comparables'],
  }
  const analysis: ListingAnalysis = { listingId: l.id, aspect, financials: fin }
  for (const key of sections[aspect]) {
    if (key === 'price') analysis.price = price
    if (key === 'completeness') analysis.completeness = completeness
    if (key === 'risks') analysis.risks = { title: tr(A.sections.risks), items: risks.map((r) => ({ level: r.level, text: fill(tr(A.risks[r.key]), r.vars ?? {}) })) }
    if (key === 'questions') analysis.questions = questions
    if (key === 'comparables' && compCards.length) analysis.comparables = { title: tr(A.sections.comparables), cards: compCards }
  }

  // Everything the responder may use (numbers it must not change).
  const facts = {
    aspect,
    price_position: position,
    price_vs_median_pct: band ? diffPct : null,
    market_sample: m.prices.length,
    market_scope: m.local ? 'same city' : 'all cities',
    median_gel: band ? Math.round(band.median) : null,
    typical_range_gel: band ? [Math.round(band.p25), Math.round(band.p75)] : null,
    price_per_m2_gel: perM2 ? Math.round(perM2) : null,
    similar_per_m2_median_gel: compM2Median ? Math.round(compM2Median) : null,
    price_per_m2_ratio_vs_similar: m2Ratio ? +m2Ratio.toFixed(2) : null,
    payback_years_if_profit_verified: l.priceGel !== null && profitGel ? +(l.priceGel / (profitGel * 12)).toFixed(1) : null,
    missing: applicable.filter((k) => !has[k]),
    risks: risks.map((r) => ({ level: r.level, risk: fill(A.risks[r.key].en, r.vars ?? {}) })),
    seller_text_red_flags: i?.redFlags ?? [],
    seller_text_risks: i?.risks ?? [],
    similar_listings: comps.map((c) => ({ title: pick(c.title, locale), price_gel: c.priceGel && Math.round(c.priceGel), city: cityLabel(c.city, locale), area_m2: c.area })),
    questions_for_seller: questionItems,
    // Where each of the facts above comes from.
    sources: {
      calculated: ['price_position', 'price_vs_median_pct', 'market_sample', 'median_gel', 'typical_range_gel', 'price_per_m2_gel', 'similar_per_m2_median_gel', 'price_per_m2_ratio_vs_similar', 'payback_years_if_profit_verified'],
      seller_claim: ['payback_years_if_profit_verified uses the profit the seller states', 'seller_text_red_flags and seller_text_risks are read from the seller text'],
      unknown: ['missing'],
      assessment: ['risks'],
    },
  }
  return { analysis, facts }
}
