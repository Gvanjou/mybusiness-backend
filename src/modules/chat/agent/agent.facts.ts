import { formatNumber, pick, type Locale, type Localized } from '../../../shared/i18n/locale.js'
import { categoriesNamed, categoryLabel, cityLabel, districtLabel } from '../../catalog/catalog.labels.js'
import type { CatalogListing, Money } from '../../catalog/catalog.model.js'
import { areaOf, peerPool, type CatalogSnapshot } from '../../catalog/catalog.service.js'
import { placeHints } from '../../competition/area.service.js'
import { approx, toGel, type FxRates } from '../../fx/fx.service.js'
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
  if (kind && kind.length <= 32 && words.length <= 3 && !genitiveOnly && SCRIPT[locale].test(kind)) return capital(kind, locale)
  if (!GENERIC.includes(l.category)) return categoryLabel(l.category, locale)
  // "სხვა · ვაკე" says nothing (production test): a business type the title or text names, else the title's first
  // two words, before the bare category.
  const named = categoriesNamed(`${pick(l.title, locale)} ${l.description.original}`).find((c) => !GENERIC.includes(c))
  if (named) return categoryLabel(named, locale)
  const first = words.slice(0, 2).join(' ')
  return first && first.length <= 32 && SCRIPT[locale].test(first) && !(locale === 'ka' && /ის$/.test(first)) ? capital(first, locale) : categoryLabel(l.category, locale)
}

const GENERIC = ['other', 'services']
// Georgian has no capitals (toUpperCase would turn Mkhedruli into Mtavruli letters).
const capital = (text: string, locale: Locale) => (locale === 'ka' ? text : text.charAt(0).toUpperCase() + text.slice(1))

// What the business is, for a chip: "საკონდიტრო".
export function kindName(l: CatalogListing, locale: Locale): string {
  return kindOf(l, locale)
}

// Where it is, as precisely as the listing says: a street written in the reply's own script, else the district
// (or the neighbourhood the text names), else the city. "Zurab Gorgiladze Street" never lands in a Georgian answer.
function placeOf(l: CatalogListing, locale: Locale): string {
  const street = placeHints(`${l.address ?? ''} ${pick(l.title, 'ka')}`).streets.find((x) => SCRIPT[locale].test(x))
  if (street) return locale === 'ka' ? street.replace(/\s+ქუჩა\b/, ' ქ.').replace(/\s+გამზირი\b/, ' გამზ.') : street
  return districtOf(l, locale) || cityLabel(l.city, locale)
}

function districtOf(l: CatalogListing, locale: Locale): string {
  return districtLabel(l.district ?? placeHints(`${pick(l.title, 'ka')} ${l.description.original}`).neighbourhood, locale)
}

// The place line of the fact sheet and the table: city and district, the same everywhere ("თბილისი, ვაკე").
export function placeLine(l: CatalogListing, locale: Locale): string {
  return [cityLabel(l.city, locale), districtOf(l, locale)].filter(Boolean).join(', ')
}

const sizeText = (l: CatalogListing, locale: Locale) => {
  const a = areaOf(l)
  return a ? `${a} ${AREA_UNIT[locale]}` : ''
}

// The card's name: kind · place · size.
export function displayName(l: CatalogListing, locale: Locale): string {
  return [kindOf(l, locale), placeOf(l, locale), sizeText(l, locale)].filter(Boolean).join(' · ')
}

// How the text names it: "საკონდიტრო, ვაკე".
export function shortName(l: CatalogListing, locale: Locale): string {
  return [kindOf(l, locale), placeOf(l, locale)].filter(Boolean).join(', ')
}

// ── Money: per month in GEL, with the figure as the seller wrote it ──

const num = (n: number, locale: Locale) => formatNumber(n, locale)
const range = (a: number, b: number, locale: Locale) => (Math.abs(b - a) < 1 ? num(a, locale) : `${num(a, locale)}–${num(b, locale)}`)
const SYMBOL: Record<string, string> = { GEL: '₾', USD: '$', EUR: '€' }
const PER_MONTH: Localized = t('/თვე', '/month', '/мес.')
const PER: Record<'day' | 'week' | 'year', Localized> = { day: t('დღეში', 'a day', 'в день'), week: t('კვირაში', 'a week', 'в неделю'), year: t('წელიწადში', 'a year', 'в год') }

function monthlyGel(m: NonNullable<Money>, rates: FxRates): [number, number] | null {
  const lo = toGel(m.min, m.currency, rates)
  const hi = toGel(m.max, m.currency, rates)
  return lo === null || hi === null ? null : [Math.round(lo), Math.round(hi)]
}

// For showing: a figure converted from another currency or another period is an estimate, rounded (see approx).
function shownGel(m: NonNullable<Money>, rates: FxRates): [number, number] | null {
  const gel = monthlyGel(m, rates)
  if (!gel) return null
  return m.currency !== 'GEL' || m.stated ? [approx(gel[0]), approx(gel[1])] : gel
}

// "≈ 5 460 ₾/თვე ($2 100)", "≈ 21 000–24 000 ₾/თვე (700–800 ₾ დღეში)": per month in lari first, then the figure as
// the seller wrote it. Dollars as "$", never "USD".
export function moneyForUi(m: Money, rates: FxRates, locale: Locale): string | null {
  if (!m) return null
  const gel = shownGel(m, rates)
  const sym = SYMBOL[m.currency] ?? m.currency
  const money = (a: number, b: number, s: string) => (s === '$' || s === '€' ? `${s}${range(a, b, locale)}` : `${range(a, b, locale)} ${s}`)
  const as = m.stated ? `${money(m.stated.min, m.stated.max, sym)} ${pick(PER[m.stated.period], locale)}` : m.currency !== 'GEL' ? money(m.min, m.max, sym) : null
  if (!gel) return as
  return `≈ ${range(gel[0], gel[1], locale)} ₾${pick(PER_MONTH, locale)}${as ? ` (${as})` : ''}`
}

// The price as the seller set it, first: "$75 000 (≈ 195 000 ₾)" for a listing in dollars, "52 000 ₾" in lari.
const priceText = (l: CatalogListing, locale: Locale) => {
  if (l.priceGel === null) return null
  if (!l.currency || l.currency === 'GEL' || !l.price) return `${num(l.priceGel, locale)} ₾`
  return `${SYMBOL[l.currency] ?? l.currency}${num(l.price, locale)} (≈ ${num(approx(l.priceGel), locale)} ₾)`
}

// How far over the budget, as shown: rounded when the price is converted.
const overBy = (l: CatalogListing, budget: number) => {
  const over = l.priceGel! - budget
  return l.currency && l.currency !== 'GEL' ? approx(over) : Math.round(over)
}

// ── Like with like: a 15 m² kiosk is not measured against the median restaurant ──

export type Peers = { medianGel: number; count: number; diffPct: number; basisUi: string }

export function peers(l: CatalogListing, s: CatalogSnapshot, locale: Locale): Peers | null {
  if (l.priceGel === null) return null
  const { pool, inCity, sized } = peerPool(l, s)
  if (pool.length < 3) return null
  const prices = pool.map((x) => x.priceGel!).sort((a, b) => a - b)
  const mid = Math.floor(prices.length / 2)
  const median = Math.round(prices.length % 2 ? prices[mid]! : (prices[mid - 1]! + prices[mid]!) / 2)
  const where = inCity && l.city ? cityLabel(l.city, locale) : pick(t('ყველა ქალაქი', 'all cities', 'все города'), locale)
  const basisUi = `${pool.length} · ${categoryLabel(l.category, locale).toLowerCase()} · ${where}${sized ? ` · ${sized[0]}–${sized[1]} ${AREA_UNIT[locale]}` : ''}`
  return { medianGel: median, count: pool.length, diffPct: Math.round((l.priceGel / median - 1) * 100), basisUi }
}

// ── The facts of a listing, each with where it comes from ──

type Place = SessionState['places'][string]
type Source = 'listing' | 'seller' | 'calc' | 'map'

const SOURCE: Record<Source, Localized> = {
  listing: t('(განცხადება)', '(listing)', '(объявление)'),
  seller: t('(გამყიდველის თქმით)', '(seller says)', '(со слов продавца)'),
  calc: t('(გათვლა)', '(calculated)', '(расчёт)'),
  map: t('(რუკა)', '(map)', '(карта)'),
}

const W = {
  notStated: t('არ არის მითითებული', 'not stated', 'не указано'),
  onRequest: t('შეთანხმებით', 'on request', 'по запросу'),
  closed: t('დაკეტილია', 'closed', 'закрыт'),
  operating: t('მოქმედი', 'operating', 'работает'),
  years: t('{n} წელი', '{n} years', '{n} лет'),
  people: t('{n} თანამშრომელი', '{n} staff', '{n} сотрудников'),
  vsSimilar: t('{pct} მსგავსებთან (მედიანა {median} ₾; {basis})', '{pct} vs similar (median {median} ₾; {basis})', '{pct} к похожим (медиана {median} ₾; {basis})'),
  fewSimilar: t('ზომით და ტიპით მსგავსი განცხადებები ცოტაა — ფასი სამართლიანად ვერ შედარდება', 'too few listings of this type and size to compare the price fairly', 'слишком мало похожих объявлений этого типа и размера для честного сравнения цены'),
  overBudget: t('{over} ₾-ით აღემატება თქვენს ბიუჯეტს ({budget} ₾)', '{over} ₾ over your budget ({budget} ₾)', 'на {over} ₾ выше вашего бюджета ({budget} ₾)'),
  inBudget: t('ჯდება თქვენს ბიუჯეტში ({budget} ₾)', 'within your budget ({budget} ₾)', 'в пределах вашего бюджета ({budget} ₾)'),
  competitors: t('{n} პირდაპირი კონკურენტი {r} მ-ში ({n150} — 150 მ-ში){nearest}', '{n} direct competitors within {r} m ({n150} within 150 m){nearest}', '{n} прямых конкурентов в радиусе {r} м ({n150} — в 150 м){nearest}'),
  nearest: t('; უახლოესი: {list}', '; nearest: {list}', '; ближайшие: {list}'),
  staffForArea: t('{n} თანამშრომელი {a} მ²-ზე — დაუჯერებლად ბევრია, გადაამოწმეთ', '{n} staff for {a} m² — implausibly many, verify', '{n} сотрудников на {a} м² — неправдоподобно много, проверьте'),
  fastPayback: t('ნათქვამი მოგებით ფასი {m} თვეში ანაზღაურდება — უჩვეულოდ სწრაფია, გადაამოწმეთ', 'at the stated profit the price pays back in {m} months — unusually fast, verify', 'при заявленной прибыли цена окупается за {m} мес. — подозрительно быстро, проверьте'),
}

// Seller claims that don't add up (round 6: "30 employees" in a 24 m² café went unchallenged): named on the fact
// sheet and the card, so the answer and the seller message question them. Under 2 m² a person, or a stated profit
// that would repay the price within 6 months.
function doubtsOf(l: CatalogListing, s: CatalogSnapshot, locale: Locale, area: number | null): string[] {
  const i = l.insights
  const out: string[] = []
  const staff = i?.staff.count
  if (area && staff && staff >= 3 && area / staff < 2) out.push(say(W.staffForArea, locale, { n: staff, a: area }))
  const profit = i?.financials.profit_monthly ? monthlyGel(i.financials.profit_monthly, s.rates) : null
  if (profit && profit[1] > 0 && l.priceGel) {
    const months = l.priceGel / profit[1]
    if (months < 6) out.push(say(W.fastPayback, locale, { m: Math.max(0.1, Math.round(months * 10) / 10) }))
  }
  return out
}

const say = (text: Localized, locale: Locale, vars: Record<string, string | number> = {}) => Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), pick(text, locale))

export type Fact = { value: string; source: Source } | null

// One function for every place a fact is shown — the fact sheet, the table, the cards — so they cannot disagree.
export function listingFacts(l: CatalogListing, s: CatalogSnapshot, state: SessionState, locale: Locale, budget?: number) {
  const i = l.insights
  const isProperty = ['real_estate', 'commercial_space', 'offices', 'warehouse', 'land'].includes(l.category)
  const money = (m: Money): Fact => {
    const v = moneyForUi(m, s.rates, locale)
    return v ? { value: v, source: 'seller' } : null
  }
  const price = priceText(l, locale)
  const p = peers(l, s, locale)
  const place = state.places[l.id] as Place | undefined
  const area = areaOf(l)
  return {
    price: { value: price ?? pick(W.onRequest, locale), source: 'listing' } as Fact,
    place: { value: placeLine(l, locale) || pick(W.notStated, locale), source: 'listing' } as Fact,
    area: area ? ({ value: `${area} ${AREA_UNIT[locale]}`, source: l.area ? 'listing' : 'seller' } as Fact) : null,
    status: i?.isOperating === false ? ({ value: pick(W.closed, locale), source: 'seller' } as Fact) : i?.isOperating ? ({ value: pick(W.operating, locale), source: 'seller' } as Fact) : null,
    rent: isProperty ? null : money(i?.premises.rent_monthly ?? null),
    rentIncome: isProperty ? money(i?.financials.rent_income_monthly ?? null) : null,
    revenue: money(i?.financials.revenue_monthly ?? null),
    profit: money(i?.financials.profit_monthly ?? null),
    staff: i?.staff.count != null ? ({ value: say(W.people, locale, { n: i.staff.count }), source: 'seller' } as Fact) : null,
    years: i?.yearsOperating != null ? ({ value: say(W.years, locale, { n: i.yearsOperating }), source: 'seller' } as Fact) : null,
    vsSimilar: p
      ? ({ value: say(W.vsSimilar, locale, { pct: `${p.diffPct > 0 ? '+' : ''}${p.diffPct}%`, median: num(approx(p.medianGel), locale), basis: p.basisUi }), source: 'calc' } as Fact)
      : l.priceGel !== null
        ? ({ value: pick(W.fewSimilar, locale), source: 'calc' } as Fact)
        : null,
    budget:
      budget && l.priceGel !== null
        ? ({ value: l.priceGel > budget ? say(W.overBudget, locale, { over: num(overBy(l, budget), locale), budget: num(budget, locale) }) : say(W.inBudget, locale, { budget: num(budget, locale) }), source: 'calc' } as Fact)
        : null,
    competitors: place
      ? ({ value: say(W.competitors, locale, { n: place.direct, r: place.radiusM, n150: place.within150m, nearest: place.nearest.length ? say(W.nearest, locale, { list: place.nearest.join(', ') }) : '' }), source: 'map' } as Fact)
      : null,
    overBudget: Boolean(budget && l.priceGel !== null && l.priceGel > budget),
    doubts: doubtsOf(l, s, locale, area),
  }
}

// What the map showed around a listing, kept for the rest of the chat.
export function rememberPlace(state: SessionState, id: string, brief: { radiusM: number; direct: number; within150m: number; nearest: string[]; precision: string }): void {
  state.places[id] = brief
  const keys = Object.keys(state.places)
  if (keys.length > 20) delete state.places[keys[0]!]
}

// ── The fact sheet the model writes from ──

// Every value is ready to quote in the reply's language, its source label attached; a fact the listing does not
// state is named in not_stated.
export function factSheet(l: CatalogListing, s: CatalogSnapshot, state: SessionState, locale: Locale, budget?: number) {
  const f = listingFacts(l, s, state, locale, budget)
  const q = (x: NonNullable<Fact>) => `${x.value} *${pick(SOURCE[x.source], locale)}*`
  const isProperty = f.rentIncome || ['real_estate', 'commercial_space', 'offices', 'warehouse', 'land'].includes(l.category)
  const reason = l.insights?.reasonForSale
  // The listing's own facts, in this order; the ones it does not state are only named in not_stated (the sheets go
  // with every model call: seven "არ არის მითითებული" lines a listing were most of a sheet).
  const facts: [string, Fact | string | undefined][] = [
    ['price', f.price],
    ['place', f.place],
    ['area', f.area],
    ['status', f.status],
    [isProperty ? 'rent_income' : 'rent', isProperty ? f.rentIncome : f.rent],
    ['turnover', f.revenue],
    ['profit', f.profit],
    ['staff', f.staff],
    ['years_open', f.years],
    ['reason_for_sale', reason ?? undefined],
  ]
  const stated = facts.flatMap(([k, x]) => (x ? [[k, typeof x === 'string' ? x : q(x)] as const] : []))
  const notStated = facts.filter(([, x]) => !x).map(([k]) => k)
  const name = shortName(l, locale)
  const type = categoryLabel(l.category, locale)
  return {
    ref: `#${refOf(state, l.id)}`,
    name,
    ...(name.startsWith(type) ? {} : { type }),
    ...(Object.fromEntries(stated) as Record<string, string>),
    ...(f.vsSimilar ? { price_vs_similar: q(f.vsSimilar) } : {}),
    // Only over the budget: the rule is to say so, with the amount; a price within it needs no line.
    ...(f.overBudget && f.budget ? { budget: q(f.budget) } : {}),
    // No competitors line: the map was not read yet (the brief says to call location_analysis first).
    ...(f.competitors ? { competitors: q(f.competitors) } : {}),
    ...(f.doubts.length ? { check: `${f.doubts.join('; ')} *${pick(SOURCE.calc, locale)}*` } : {}),
    // The score an earlier answer gave: repeated, not redone (see the brief).
    ...(state.scores[l.id] ? { score: state.scores[l.id] } : {}),
    ...(notStated.length ? { not_stated: notStated.join(', ') } : {}),
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
  overBudget: t('ბიუჯეტზე {v} ₾-ით მეტი', '{v} ₾ over budget', 'На {v} ₾ выше бюджета'),
  property: t('ქონებაა, არა ბიზნესი', 'Property, not a business', 'Недвижимость, не бизнес'),
  doubt: t('გადასამოწმებელია', 'Verify the claims', 'Проверьте данные'),
}

type Tag = ListingCard['reasons'][number]

function tagsFor(l: CatalogListing, s: CatalogSnapshot, locale: Locale, budget?: number): Tag[] {
  const i = l.insights
  const out: Tag[] = []
  const isProperty = ['real_estate', 'commercial_space', 'offices', 'warehouse', 'land'].includes(l.category)
  if (budget && l.priceGel !== null && l.priceGel > budget) out.push({ code: 'OVER_BUDGET', label: say(TAG.overBudget, locale, { v: num(overBy(l, budget), locale) }), tone: 'warn' })
  if (i?.isOperating === false) out.push({ code: 'CLOSED', label: say(TAG.closed, locale), tone: 'warn' })
  if (doubtsOf(l, s, locale, areaOf(l)).length) out.push({ code: 'CHECK_CLAIMS', label: say(TAG.doubt, locale), tone: 'warn' })
  if (isProperty) out.push({ code: 'PROPERTY_NOT_BUSINESS', label: say(TAG.property, locale), tone: 'info' })
  const revenue = moneyForUi(i?.financials.revenue_monthly ?? null, s.rates, locale)
  if (revenue) out.push({ code: 'REVENUE', label: say(TAG.revenue, locale, { v: revenue.replace(/\s*\(.*\)$/, '') }), tone: 'good' })
  else if (!isProperty && !i?.financials.profit_monthly) out.push({ code: 'NO_FINANCIALS', label: say(TAG.noFinancials, locale), tone: 'warn' })
  const rent = moneyForUi(i?.premises.rent_monthly ?? null, s.rates, locale)
  if (rent) out.push({ code: 'RENT', label: say(TAG.rent, locale, { v: rent.replace(/\s*\(.*\)$/, '') }), tone: 'info' })
  const p = peers(l, s, locale)
  if (p && Math.abs(p.diffPct) >= 15) out.push(p.diffPct < 0 ? { code: 'BELOW_SIMILAR', label: say(TAG.cheaper, locale, { p: Math.abs(p.diffPct) }), tone: 'good' } : { code: 'ABOVE_SIMILAR', label: say(TAG.pricier, locale, { p: p.diffPct }), tone: 'warn' })
  if (i?.yearsOperating && i.yearsOperating >= 1) out.push({ code: 'YEARS', label: say(TAG.years, locale, { n: i.yearsOperating }), tone: 'good' })
  if (i?.isOperating && out.length < 3) out.push({ code: 'OPERATING', label: say(TAG.operating, locale), tone: 'good' })
  return out.slice(0, 3)
}

// The card for a listing in this chat: its number, its short name and the facts that set it apart.
export function cardFor(l: CatalogListing, s: CatalogSnapshot, state: SessionState, locale: Locale, scored?: Scored, budget?: number): ListingCard {
  return { ...toCard(l, locale, scored, s.rates.USD), area: areaOf(l), n: refOf(state, l.id), name: displayName(l, locale), reasons: tagsFor(l, s, locale, budget) }
}

// ── The comparison table: the same facts, in the client's language ──

const ROW = {
  price: t('ფასი', 'Price', 'Цена'),
  similar: t('მსგავსებთან შედარებით', 'vs similar listings', 'К похожим'),
  budget: t('ბიუჯეტთან', 'vs your budget', 'К бюджету'),
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
  within: t('{n} — {r} მ-ში', '{n} within {r} m', '{n} в радиусе {r} м'),
}

export type CompareTable = {
  kind?: 'listings' | 'profit'
  title?: string
  columns: string[]
  heads: { id: string; n?: number; name: string; url?: string }[]
  rows: { key: string; label: string; values: string[] }[]
}

export function compareTable(listings: CatalogListing[], s: CatalogSnapshot, state: SessionState, locale: Locale, urlOf: (l: CatalogListing) => string, budget?: number): CompareTable {
  const L = (k: keyof typeof ROW) => pick(ROW[k], locale)
  const dash = '—'
  const facts = listings.map((l) => listingFacts(l, s, state, locale, budget))
  const row = (key: string, label: string, pick: (f: (typeof facts)[number], l: CatalogListing) => string | null | undefined) => ({ key, label, values: facts.map((f, i) => pick(f, listings[i]!) || dash) })
  const rows = [
    row('price', L('price'), (f) => f.price?.value),
    row('similar', L('similar'), (f) => (f.vsSimilar && /%/.test(f.vsSimilar.value) ? f.vsSimilar.value : null)),
    row('budget', L('budget'), (f) => f.budget?.value),
    row('place', L('place'), (f) => f.place?.value),
    row('area', L('area'), (f) => f.area?.value),
    row('status', L('status'), (f) => f.status?.value),
    row('rent', L('rent'), (f) => f.rent?.value),
    row('rent_income', L('rentIncome'), (f) => f.rentIncome?.value),
    row('revenue', L('revenue'), (f) => f.revenue?.value),
    row('profit', L('profit'), (f) => f.profit?.value),
    row('staff', L('staff'), (f, l) => (l.insights?.staff.count != null ? String(l.insights.staff.count) : null)),
    row('years', L('years'), (f, l) => (l.insights?.yearsOperating != null ? String(l.insights.yearsOperating) : null)),
    row('competitors', L('competitors'), (f, l) => {
      const p = state.places[l.id]
      return p ? L('within').replace('{n}', String(p.direct)).replace('{r}', String(p.radiusM)) : null
    }),
  ]
  return {
    kind: 'listings',
    columns: listings.map((l) => l.id),
    heads: listings.map((l) => ({ id: l.id, n: refOf(state, l.id), name: displayName(l, locale), url: urlOf(l) })),
    // A row with nothing for any listing says nothing.
    rows: rows.filter((r) => r.values.some((v) => v !== dash)),
  }
}
