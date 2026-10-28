import { pick, type Locale, type Localized } from '../../../shared/i18n/locale.js'
import { categoryLabel, cityLabel, districtLabel } from '../../catalog/catalog.labels.js'
import type { CatalogListing, Money } from '../../catalog/catalog.model.js'
import { peerPool, type CatalogSnapshot } from '../../catalog/catalog.service.js'
import { placeHints } from '../../competition/area.service.js'
import { toGel, type FxRates } from '../../fx/fx.service.js'
import type { SessionState } from '../chat.model.js'
import { toCard, type ListingCard } from '../tools/cards.js'
import type { Scored } from '../tools/search.tool.js'

// One fact sheet per listing for the whole chat. Its numbers come from code — the listing, the seller's text read by
// rules, our arithmetic over similar listings and the map — so the card, the comparison table and every answer quote
// the same rent, turnover, size and competitors. The model writes from it instead of re-reading the text each time.

const t = (ka: string, en: string, ru: string): Localized => ({ ka, en, ru })

// ── Numbers: listing #n is the same listing on its card and in every answer of the chat ──

export function refOf(state: SessionState, id: string): number {
  let i = state.refs.indexOf(id)
  if (i === -1) {
    state.refs.push(id)
    i = state.refs.length - 1
  }
  return i + 1
}

export function idOfRef(state: SessionState, n: number): string | undefined {
  return state.refs[n - 1]
}

// ── Names: "კაფე · მაჩაბლის ქ. · 22 მ²" instead of "იყიდება მოქმედი კაფე თბილისში" ──

// Words that say nothing about what the business is: sale words, "business", "operating", "urgent".
const FILLER: Record<Locale, RegExp> = {
  ka: /^(იყიდება|იყიდებ\S*|სასწრაფოდ|მოქმედი|მომქმედი|ფუნქციონირებადი|მზა|ბიზნესი|ბიზნესის|გასაყიდი|ახალი|კარგი|ძალიან|და|ან|ქირავდება|შენობა|კონფიდენციალური|პრემიუმ)$/,
  en: /^(for|sale|selling|sell|urgent|urgently|operating|running|ready|turnkey|business|the|a|an|in|of|and|new|confidential|premium)$/i,
  ru: /^(продается|продаётся|продам|продажа|срочно|действующий|действующая|действующее|готовый|готовая|бизнес|бизнеса|в|на|и|новый|конфиденциально)$/i,
}
const SCRIPT: Record<Locale, RegExp> = { ka: /[ა-ჰ]/, en: /[a-z]/i, ru: /[а-яё]/i }
const AREA_UNIT: Record<Locale, string> = { ka: 'მ²', en: 'm²', ru: 'м²' }

// What the business is, from its title: "იყიდება მოქმედი საკონდიტრო ბიზნესი" → "საკონდიტრო". Falls back to the
// category when the title is an address, a brand in another script, or only filler.
function kindOf(l: CatalogListing, locale: Locale): string {
  const title = pick(l.title, locale).split(/\s[-–—|]\s|[,!?:;()|]/)[0] ?? ''
  const all = title.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean)
  const words = all
    // "სილამაზის სალონის ბიზნესი" keeps "ბიზნესი": after a genitive it is part of the name, not filler.
    .filter((w, i) => !FILLER[locale].test(w) || (locale === 'ka' && /^ბიზნესი$/.test(w) && /ის$/.test(all[i - 1] ?? '')))
    .filter((w) => !/\d/.test(w))
    // "ვაკეში", "საბურთალოზე", "თბილისში": places are shown separately.
    .filter((w) => !(locale === 'ka' && /(ში|ზე)$/.test(w) && w.length > 4))
  const kind = words.slice(0, 3).join(' ')
  const genitiveOnly = locale === 'ka' && /ის$/.test(kind)
  if (!kind || kind.length > 32 || words.length > 3 || genitiveOnly || !SCRIPT[locale].test(kind)) return categoryLabel(l.category, locale)
  // Georgian has no capitals (toUpperCase would turn Mkhedruli into Mtavruli letters).
  return locale === 'ka' ? kind : kind.charAt(0).toUpperCase() + kind.slice(1)
}

// What the business is, for a chip: "საკონდიტრო".
export function kindName(l: CatalogListing, locale: Locale): string {
  return kindOf(l, locale)
}

// Where it is, as precisely as the listing says: a street, else the district, else the city.
function placeOf(l: CatalogListing, locale: Locale): string {
  if (locale === 'ka') {
    const street = placeHints(`${l.address ?? ''} ${pick(l.title, 'ka')}`).streets[0]
    if (street) return street.replace(/\s+ქუჩა\b/, ' ქ.').replace(/\s+გამზირი\b/, ' გამზ.')
  }
  const district = l.district ?? placeHints(`${pick(l.title, 'ka')} ${l.description.original}`).neighbourhood
  return districtLabel(district, locale) || cityLabel(l.city, locale)
}

// The card's name: kind · place · size.
export function displayName(l: CatalogListing, locale: Locale): string {
  return [kindOf(l, locale), placeOf(l, locale), l.area ? `${l.area} ${AREA_UNIT[locale]}` : ''].filter(Boolean).join(' · ')
}

// How the text names it: "საკონდიტრო, ვაკე".
export function shortName(l: CatalogListing, locale: Locale): string {
  return [kindOf(l, locale), placeOf(l, locale)].filter(Boolean).join(', ')
}

// ── Money: per month in GEL, with the figure as the seller wrote it ──

const nf = (locale: Locale | 'model') => new Intl.NumberFormat(locale === 'en' || locale === 'model' ? 'en-US' : locale === 'ru' ? 'ru-RU' : 'ka-GE', { maximumFractionDigits: 0 })
const range = (a: number, b: number, locale: Locale | 'model') => (Math.abs(b - a) < 1 ? nf(locale).format(a) : `${nf(locale).format(a)}–${nf(locale).format(b)}`)
const SYMBOL: Record<string, string> = { GEL: '₾', USD: '$', EUR: '€' }
const PER_MONTH: Localized = t('/თვე', '/month', '/мес.')
const PER: Record<'day' | 'week' | 'year', Localized> = { day: t('დღეში', 'a day', 'в день'), week: t('კვირაში', 'a week', 'в неделю'), year: t('წელიწადში', 'a year', 'в год') }

function monthlyGel(m: NonNullable<Money>, rates: FxRates): [number, number] | null {
  const lo = toGel(m.min, m.currency, rates)
  const hi = toGel(m.max, m.currency, rates)
  return lo === null || hi === null ? null : [Math.round(lo), Math.round(hi)]
}

// For the model: "≈ 5,460 GEL/month (seller: 2,100 USD/month)", "≈ 21,000–24,000 GEL/month (seller: 700–800 GEL a day)".
function moneyForModel(m: Money, rates: FxRates): string | null {
  if (!m) return null
  const gel = monthlyGel(m, rates)
  const as = m.stated ? `${range(m.stated.min, m.stated.max, 'model')} ${m.currency} ${PER[m.stated.period].en}` : m.currency !== 'GEL' ? `${range(m.min, m.max, 'model')} ${m.currency}/month` : null
  if (!gel) return as
  return `≈ ${range(gel[0], gel[1], 'model')} GEL/month${as ? ` (seller wrote: ${as})` : ''}`
}

// For the UI: "≈ 5 460 ₾/თვე ($2 100)", "≈ 21 000–24 000 ₾/თვე (700–800 ₾ დღეში)".
export function moneyForUi(m: Money, rates: FxRates, locale: Locale): string | null {
  if (!m) return null
  const gel = monthlyGel(m, rates)
  const sym = SYMBOL[m.currency] ?? m.currency
  const money = (a: number, b: number, s: string) => (s === '$' || s === '€' ? `${s}${range(a, b, locale)}` : `${range(a, b, locale)} ${s}`)
  const as = m.stated ? `${money(m.stated.min, m.stated.max, sym)} ${pick(PER[m.stated.period], locale)}` : m.currency !== 'GEL' ? money(m.min, m.max, sym) : null
  if (!gel) return as
  return `≈ ${range(gel[0], gel[1], locale)} ₾${pick(PER_MONTH, locale)}${as ? ` (${as})` : ''}`
}

// ── Like with like: a 15 m² kiosk is not measured against the median restaurant ──

export type Peers = { medianGel: number; count: number; diffPct: number; basis: string; basisUi: string }

export function peers(l: CatalogListing, s: CatalogSnapshot, locale: Locale): Peers | null {
  if (l.priceGel === null) return null
  const { pool, inCity, sized } = peerPool(l, s)
  if (pool.length < 3) return null
  const prices = pool.map((x) => x.priceGel!).sort((a, b) => a - b)
  const mid = Math.floor(prices.length / 2)
  const median = Math.round(prices.length % 2 ? prices[mid]! : (prices[mid - 1]! + prices[mid]!) / 2)
  const type = categoryLabel(l.category, 'en').toLowerCase()
  const typeUi = categoryLabel(l.category, locale).toLowerCase()
  const basis = [`${pool.length} ${type} listings`, inCity && l.city ? `in ${l.city}` : 'in all cities', sized ? `of ${sized[0]}–${sized[1]} m²` : ''].filter(Boolean).join(' ')
  const where = inCity && l.city ? cityLabel(l.city, locale) : pick(t('ყველა ქალაქი', 'all cities', 'все города'), locale)
  const basisUi = `${pool.length} · ${typeUi} · ${where}${sized ? ` · ${sized[0]}–${sized[1]} ${AREA_UNIT[locale]}` : ''}`
  return { medianGel: median, count: pool.length, diffPct: Math.round((l.priceGel / median - 1) * 100), basis, basisUi }
}

// ── The fact sheet the model writes from ──

type Place = SessionState['places'][string]

// What the map showed around a listing, kept for the rest of the chat.
export function rememberPlace(state: SessionState, id: string, brief: { radiusM: number; direct: number; within150m: number; nearest: string[]; precision: string }): void {
  state.places[id] = brief
  const keys = Object.keys(state.places)
  if (keys.length > 20) delete state.places[keys[0]!]
}

const placeText = (p: Place | undefined) =>
  p ? `${p.direct} direct competitors within ${p.radiusM} m (${p.within150m} of them within 150 m)${p.nearest.length ? `; nearest: ${p.nearest.join(', ')}` : ''} — OpenStreetMap, location found by ${p.precision}` : 'not analysed yet: call location_analysis before saying anything about competitors'

export function factSheet(l: CatalogListing, s: CatalogSnapshot, state: SessionState, locale: Locale) {
  const i = l.insights
  const isProperty = ['real_estate', 'commercial_space', 'offices', 'warehouse', 'land'].includes(l.category)
  const p = peers(l, s, locale)
  const status = i?.isOperating === false ? 'closed (seller says)' : i?.isOperating ? 'operating (seller says)' : 'not stated'
  const notStated = 'not stated in the listing'
  return {
    ref: `#${refOf(state, l.id)}`,
    name: shortName(l, locale),
    id: l.shortId,
    listing: {
      type: categoryLabel(l.category, 'en'),
      place: [cityLabel(l.city, 'en'), districtLabel(l.district, 'en'), l.address].filter(Boolean).join(', ') || 'not stated',
      price: l.priceGel === null ? (l.negotiable ? 'on request' : 'not stated') : `${nf('model').format(Math.round(l.priceGel))} GEL${l.currency && l.currency !== 'GEL' && l.price ? ` (${nf('model').format(l.price)} ${l.currency})` : ''}`,
      area_m2: l.area ?? 'not stated',
    },
    seller_says: {
      status,
      rent_paid: isProperty ? undefined : (moneyForModel(i?.premises.rent_monthly ?? null, s.rates) ?? notStated),
      rent_income: isProperty ? (moneyForModel(i?.financials.rent_income_monthly ?? null, s.rates) ?? notStated) : undefined,
      revenue: moneyForModel(i?.financials.revenue_monthly ?? null, s.rates) ?? notStated,
      profit: moneyForModel(i?.financials.profit_monthly ?? null, s.rates) ?? notStated,
      staff: i?.staff.count ?? notStated,
      years_operating: i?.yearsOperating ?? notStated,
      reason_for_sale: i?.reasonForSale ?? notStated,
    },
    calculated: {
      price_vs_similar: p ? `${p.diffPct > 0 ? '+' : ''}${p.diffPct}% vs the median ${nf('model').format(p.medianGel)} GEL of ${p.basis}` : 'too few similar listings to compare the price fairly',
    },
    map: placeText(state.places[l.id]),
  }
}

// ── Cards: numbered, named, and tagged with the facts that tell them apart ──

const TAG = {
  closed: t('დაკეტილია', 'Closed', 'Закрыт'),
  operating: t('მოქმედი', 'Operating', 'Работает'),
  rent: t('ქირა {v}', 'Rent {v}', 'Аренда {v}'),
  revenue: t('ბრუნვა {v}', 'Turnover {v}', 'Выручка {v}'),
  noFinancials: t('ფინანსები მითითებული არ არის', 'No financial data', 'Финансы не указаны'),
  years: t('{n} წელია მუშაობს', '{n} years operating', 'Работает {n} лет'),
  cheaper: t('{p}% იაფი მსგავსებზე', '{p}% below similar', 'На {p}% дешевле похожих'),
  pricier: t('{p}% ძვირი მსგავსებზე', '{p}% above similar', 'На {p}% дороже похожих'),
  property: t('ქონებაა, არა ბიზნესი', 'Property, not a business', 'Недвижимость, не бизнес'),
}

type Tag = ListingCard['reasons'][number]

function tagsFor(l: CatalogListing, s: CatalogSnapshot, locale: Locale): Tag[] {
  const i = l.insights
  const say = (key: keyof typeof TAG, vars: Record<string, string | number> = {}) => Object.entries(vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), pick(TAG[key], locale))
  const out: Tag[] = []
  const isProperty = ['real_estate', 'commercial_space', 'offices', 'warehouse', 'land'].includes(l.category)
  if (i?.isOperating === false) out.push({ code: 'CLOSED', label: say('closed'), tone: 'warn' })
  if (isProperty) out.push({ code: 'PROPERTY_NOT_BUSINESS', label: say('property'), tone: 'info' })
  const revenue = moneyForUi(i?.financials.revenue_monthly ?? null, s.rates, locale)
  if (revenue) out.push({ code: 'REVENUE', label: say('revenue', { v: revenue.replace(/\s*\(.*\)$/, '') }), tone: 'good' })
  else if (!isProperty && !i?.financials.profit_monthly) out.push({ code: 'NO_FINANCIALS', label: say('noFinancials'), tone: 'warn' })
  const rent = moneyForUi(i?.premises.rent_monthly ?? null, s.rates, locale)
  if (rent) out.push({ code: 'RENT', label: say('rent', { v: rent.replace(/\s*\(.*\)$/, '') }), tone: 'info' })
  const p = peers(l, s, locale)
  if (p && Math.abs(p.diffPct) >= 15) out.push(p.diffPct < 0 ? { code: 'BELOW_SIMILAR', label: say('cheaper', { p: Math.abs(p.diffPct) }), tone: 'good' } : { code: 'ABOVE_SIMILAR', label: say('pricier', { p: p.diffPct }), tone: 'warn' })
  if (i?.yearsOperating && i.yearsOperating >= 1) out.push({ code: 'YEARS', label: say('years', { n: i.yearsOperating }), tone: 'good' })
  if (i?.isOperating && out.length < 3) out.push({ code: 'OPERATING', label: say('operating'), tone: 'good' })
  return out.slice(0, 3)
}

// The card for a listing in this chat: its number, its short name and the facts that set it apart.
export function cardFor(l: CatalogListing, s: CatalogSnapshot, state: SessionState, locale: Locale, scored?: Scored): ListingCard {
  return { ...toCard(l, locale, scored, s.rates.USD), n: refOf(state, l.id), name: displayName(l, locale), reasons: tagsFor(l, s, locale) }
}

// ── The comparison table: the same facts, in the client's language ──

const ROW = {
  price: t('ფასი', 'Price', 'Цена'),
  similar: t('მსგავსებთან შედარებით', 'vs similar listings', 'К похожим'),
  place: t('მდებარეობა', 'Location', 'Локация'),
  area: t('ფართობი', 'Area', 'Площадь'),
  status: t('სტატუსი', 'Status', 'Статус'),
  rent: t('ქირა', 'Rent', 'Аренда'),
  rentIncome: t('ქირის შემოსავალი', 'Rent income', 'Доход от аренды'),
  revenue: t('ბრუნვა (გამყიდველის)', 'Turnover (seller)', 'Выручка (продавец)'),
  profit: t('მოგება (გამყიდველის)', 'Profit (seller)', 'Прибыль (продавец)'),
  staff: t('თანამშრომლები', 'Staff', 'Персонал'),
  years: t('მუშაობის წლები', 'Years operating', 'Лет работы'),
  competitors: t('კონკურენტები ახლოს', 'Competitors nearby', 'Конкуренты рядом'),
  onRequest: t('შეთანხმებით', 'On request', 'По запросу'),
  closed: t('დაკეტილია', 'Closed', 'Закрыт'),
  operating: t('მოქმედი', 'Operating', 'Работает'),
  within: t('{n} — {r} მ-ში', '{n} within {r} m', '{n} в радиусе {r} м'),
}

// listings: listings side by side (heads link to them) · profit: the three profit scenarios of profit_scenarios.
export type CompareTable = {
  kind?: 'listings' | 'profit'
  title?: string
  columns: string[]
  heads: { id: string; n?: number; name: string; url?: string }[]
  rows: { key: string; label: string; values: string[] }[]
}

export function compareTable(listings: CatalogListing[], s: CatalogSnapshot, state: SessionState, locale: Locale, urlOf: (l: CatalogListing) => string): CompareTable {
  const L = (k: keyof typeof ROW) => pick(ROW[k], locale)
  const gel = (n: number) => `${nf(locale).format(Math.round(n))} ₾`
  const dash = '—'
  const rows: { key: string; label: string; values: string[] }[] = [
    { key: 'price', label: L('price'), values: listings.map((l) => (l.priceGel === null ? L('onRequest') : gel(l.priceGel))) },
    {
      key: 'similar',
      label: L('similar'),
      values: listings.map((l) => {
        const p = peers(l, s, locale)
        return p ? `${p.diffPct > 0 ? '+' : ''}${p.diffPct}% (${p.basisUi})` : dash
      }),
    },
    { key: 'place', label: L('place'), values: listings.map((l) => [cityLabel(l.city, locale), districtLabel(l.district, locale)].filter(Boolean).join(', ') || dash) },
    { key: 'area', label: L('area'), values: listings.map((l) => (l.area ? `${l.area} ${AREA_UNIT[locale]}` : dash)) },
    { key: 'status', label: L('status'), values: listings.map((l) => (l.insights?.isOperating === false ? L('closed') : l.insights?.isOperating ? L('operating') : dash)) },
    { key: 'rent', label: L('rent'), values: listings.map((l) => moneyForUi(l.insights?.premises.rent_monthly ?? null, s.rates, locale) ?? dash) },
    { key: 'rent_income', label: L('rentIncome'), values: listings.map((l) => moneyForUi(l.insights?.financials.rent_income_monthly ?? null, s.rates, locale) ?? dash) },
    { key: 'revenue', label: L('revenue'), values: listings.map((l) => moneyForUi(l.insights?.financials.revenue_monthly ?? null, s.rates, locale) ?? dash) },
    { key: 'profit', label: L('profit'), values: listings.map((l) => moneyForUi(l.insights?.financials.profit_monthly ?? null, s.rates, locale) ?? dash) },
    { key: 'staff', label: L('staff'), values: listings.map((l) => (l.insights?.staff.count != null ? String(l.insights.staff.count) : dash)) },
    { key: 'years', label: L('years'), values: listings.map((l) => (l.insights?.yearsOperating != null ? String(l.insights.yearsOperating) : dash)) },
    {
      key: 'competitors',
      label: L('competitors'),
      values: listings.map((l) => {
        const p = state.places[l.id]
        return p ? L('within').replace('{n}', String(p.direct)).replace('{r}', String(p.radiusM)) : dash
      }),
    },
  ]
  return {
    kind: 'listings',
    columns: listings.map((l) => l.id),
    heads: listings.map((l) => ({ id: l.id, n: refOf(state, l.id), name: displayName(l, locale), url: urlOf(l) })),
    // A row with nothing for any listing says nothing.
    rows: rows.filter((r) => r.values.some((v) => v !== dash)),
  }
}
