import { extractAmounts } from '../../shared/text/amounts.js'
import type { CatalogListing, Money } from './catalog.model.js'

// Facts read from the listing text by rules, without a model call, so search ranking and the comparison table
// use what the seller wrote. Gemini reads the full text itself when it looks at a listing. Everything here is the
// seller's own claim. Works on Georgian, English and Russian text.

type Insights = NonNullable<CatalogListing['insights']>
export type SiteFields = {
  employees: number | null
  yearEstablished: number | null
  revenueMonthly: number | null
  incomeMonthly: number | null
  currency: string | null
}

const NUM_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, ორი: 2, სამი: 3, ოთხი: 4, ხუთი: 5, два: 2, две: 2, три: 3, четыре: 4, пять: 5,
}

const STAFF = [
  /(\d{1,4})\s*(?:\+\s*)?(?:employees|staff|workers|people on the team|თანამშრომ|მუშაკ|сотрудник|работник)/i,
  /(?:team|გუნდი|команда|персонал)\D{0,25}?\(?(\d{1,4})\s*(?:people|employees|თანამშრომ|человек|сотрудник)?/i,
]
const SINCE = [
  /(?:since|from|established in|founded in|opened in|operating since)\s*((?:19|20)\d{2})/i,
  /((?:19|20)\d{2})\s*წლიდან/,
  /(?:с|основан\S*\s+в|открыт\S*\s+в)\s*((?:19|20)\d{2})/i,
]
const YEARS = /(\d{1,2})\s*(?:\+\s*)?(?:years? (?:of operation|in business|operating|on the market)|წელია|წლის განმავლობაში|лет (?:работы|на рынке))/i
const RATING = /(Wolt|Glovo|Bolt(?: Food)?|Google(?: Maps)?|TripAdvisor|Booking(?:\.com)?|Airbnb|Yandex)[^\d\n]{0,20}(\d+(?:[.,]\d+)?\s*(?:\/\s*\d+|%))/gi
const REPEAT = [/(\d{1,3})\s*%[^.\n%]{0,50}(?:repeat|returning|regular|განმეორებით|მუდმივ|постоянн|повторн)/i, /(?:repeat|returning|regular|განმეორებით|постоянн|повторн)[^.\n%]{0,50}?(\d{1,3})\s*%/i]
const LOCATIONS = /(\d|two|three|four|five|ორი|სამი|ოთხი|ხუთი|два|две|три|четыре|пять)\s*(dark kitchens?|branches|locations|outlets|ფილიალ|წერტილ|dark kitchen-|филиал|точк)/gi
const ON_REQUEST = /(financ|P&L|revenue|figures|ფინანს|შემოსავ|финанс|выручк)[^.\n]{0,80}(on request|upon request|მოთხოვნის|по запросу)/i
const LEASED = /\b(leased|lease|rented premises|rent is)\b|იჯარ|аренд/i
const OWNED = /\b(own(ed)? (premises|property|building|space))\b|საკუთრებაშია|საკუთარი ფართ|в собственности|собственное помещение/i
const OPERATING = /fully operat|operating business|currently operating|running business|მოქმედი|ფუნქციონირებად|действующ|работающ/i
// Closed now. "დახურული ტერასა" (a covered terrace) is not a closed business, so only the predicate counts.
const CLOSED = /დახურულია|ამჟამად დახურული|დროებით დახურული|არ ფუნქც?იონირებს|ამჟამად არ მუშაობს|შეჩერებულია|currently closed|temporarily closed|is closed|not operating|not in operation|не работает|временно закрыт|сейчас закрыт/i
// Floor area as sellers write it: "21 კვ.მ", "46 კვ", "120 მ²", "80 m2", "35 sq m", "60 кв.м".
const AREA = /(\d{1,5}(?:[.,]\d+)?)\s*(?:კვ\.?\s?მ\b|კვ\.?(?![ა-ჰ])|კვადრატ|მ²|მ2|m²|m2\b|sq\.?\s?m|кв\.?\s?м)/i
const REASON = /(?:reason for (?:the )?sale|selling (?:because|due to)|გაყიდვის მიზეზ\S*|იყიდება იმის გამო|причина продажи)[:\s—-]*([^.\n]{5,120})/i
// The reason given as a "because" after the sale or the closure: "არ ფუნქციონირებს, რადგან მეპატრონეს საზღვარგარეთ
// მოუწია წასვლა", "not operating because the owner had to go abroad". It ends at the first comma (a phone number
// or the rent often follows).
const REASON_BECAUSE = /(?:იყიდება|ვყიდი|გავყიდი|არ ფუნქც?იონირებს|არ მუშაობს|დახურულია|for sale|selling|not operating|closed|продаю|продаётся|продается|не работает|закрыт)[^.\n]{0,60}?(?:რადგან(?:აც)?|იმიტომ,? რომ|because(?: of)?|due to|since|так как|потому что|в связи с)\s+([^.\n,;]{5,120})/i

const INCLUDED: [RegExp, string][] = [
  [/brand|ბრენდ|бренд/i, 'brand'],
  [/menu|recipes|მენიუ|რეცეპტ|меню|рецепт/i, 'menu and recipes'],
  [/team|staff|გუნდ|პერსონალ|команд|персонал/i, 'trained team'],
  [/equipment|inventory|აღჭურვილ|ინვენტარ|оборудован|инвентар/i, 'equipment'],
  [/supplier|მომწოდებ|поставщик/i, 'supplier network'],
  [/Wolt|Glovo|Bolt|delivery platform|მიწოდების პლატფორმ|платформ\S* доставки/i, 'delivery platform accounts'],
  [/furniture|ავეჯ|мебел/i, 'furniture'],
  [/licen[cs]e|permit|ლიცენზ|ნებართვ|лицензи/i, 'licences'],
]

const money = (value: number, currency: string, evidence: string): Money => ({ min: value, max: value, currency, evidence })

export function textInsights(p: {
  category: string
  dealType: string
  texts: string[] // description in every language the site has
  site: SiteFields
  hasLocation: boolean
  priceKnown: boolean
}): Insights {
  const text = p.texts.filter(Boolean).join('\n')
  const first = (patterns: RegExp[]) => patterns.map((r) => text.match(r)).find(Boolean) ?? null

  // Staff and years: the site's own fields first, then the text.
  const staffMatch = first(STAFF)
  const staff = p.site.employees ?? (staffMatch ? Number(staffMatch[1]) : null)
  const sinceMatch = first(SINCE)
  const thisYear = new Date().getFullYear()
  const since = p.site.yearEstablished ?? (sinceMatch ? Number(sinceMatch[1]) : null)
  const yearsMatch = text.match(YEARS)
  const years = since && since <= thisYear ? thisYear - since : yearsMatch ? Number(yearsMatch[1]) : null

  // Money the seller states: monthly revenue / profit / rent (never the asking price).
  const cur = p.site.currency ?? 'GEL'
  const amounts = extractAmounts(text)
  const monthly = (role: 'revenue' | 'profit' | 'rent') => {
    // Of several figures, one that says its period ("თვეში", "დღიური") beats a bare one (often a total or a goal).
    const a = amounts.filter((x) => x.role === role).sort((x, y) => Number(!x.period) - Number(!y.period))[0]
    if (!a) return null
    const top = a.max ?? a.value
    const perMonth = { day: 30, week: 4.33, year: 1 / 12 }
    if (!a.period || a.period === 'month') return { min: a.value, max: top, currency: a.currency, evidence: `${role} stated in the listing text` }
    const k = perMonth[a.period]
    return { min: Math.round(a.value * k), max: Math.round(top * k), currency: a.currency, evidence: `${role} stated in the listing text, per ${a.period}`, stated: { min: a.value, max: top, period: a.period } }
  }
  const revenue = p.site.revenueMonthly ? money(p.site.revenueMonthly, cur, 'monthly revenue field on mybusiness.ge') : monthly('revenue')
  const profit = p.site.incomeMonthly ? money(p.site.incomeMonthly, cur, 'monthly income field on mybusiness.ge') : monthly('profit')
  // "Rent 3 000 ₾" in a business listing is what the business pays for its premises; only property earns rent.
  const isProperty = ['real_estate', 'commercial_space', 'offices', 'warehouse', 'land'].includes(p.category)
  const rent = monthly('rent')
  const rentIncome = isProperty ? rent : null
  const rentPaid = isProperty ? null : rent
  const onRequest = ON_REQUEST.test(text)

  // The same text often appears in two or three languages: keep each fact once.
  const ratings = new Map<string, string>()
  for (const m of text.matchAll(RATING)) {
    const platform = m[1]!.replace(/ (Food|Maps)$/i, '').replace(/\.com$/i, '')
    if (!ratings.has(platform.toLowerCase())) ratings.set(platform.toLowerCase(), `${platform}|${m[2]!.replace(/\s+/g, '')}`)
  }
  const repeat = REPEAT.map((r) => text.match(r)).find(Boolean)
  const repeatPct = repeat ? Number(repeat[1]) : null
  const sites = new Map<string, { count: number; kind: string }>()
  for (const m of text.matchAll(LOCATIONS)) {
    const count = NUM_WORDS[m[1]!.toLowerCase()] ?? Number(m[1])
    const kind = /dark kitchen/i.test(m[2]!) ? 'dark_kitchen' : 'branch'
    if (count > 1 && !sites.has(kind)) sites.set(kind, { count, kind })
  }
  const highlights = {
    ratings: [...ratings.values()].map((x) => ({ platform: x.split('|')[0]!, value: x.split('|')[1]! })),
    repeatPct,
    sites: [...sites.values()],
    onRequest: false,
  }
  const strengths = [
    ...highlights.ratings.map((r) => `${r.platform} rating ${r.value}`),
    ...(repeatPct ? [`${repeatPct}% repeat customers`] : []),
    ...highlights.sites.map((x) => `${x.count} ${x.kind === 'dark_kitchen' ? 'dark kitchens' : 'branches'}`),
    ...(years && years >= 3 ? [`operating for about ${years} years`] : []),
  ]

  const tenure = OWNED.test(text) ? 'owned' : LEASED.test(text) ? 'leased' : 'unknown'
  const reason = (text.match(REASON) ?? text.match(REASON_BECAUSE))?.[1]?.trim() ?? null
  const areaMatch = text.match(AREA)
  const areaValue = areaMatch ? Number(areaMatch[1]!.replace(',', '.')) : null
  const area = areaValue !== null && areaValue >= 4 && areaValue <= 20_000 ? Math.round(areaValue) : null
  const included = [...new Set(INCLUDED.filter(([r]) => r.test(text)).map(([, label]) => label))]

  const missing = [
    !revenue && !profit && (onRequest ? 'revenue and profit (available on request)' : 'revenue and profit'),
    tenure === 'unknown' && 'whether the premises are owned or leased',
    staff === null && 'number of staff',
    years === null && 'how long it has operated',
    !reason && 'reason for sale',
  ].filter((x): x is string => Boolean(x))

  let score = 0
  if (revenue || profit || rentIncome) score += 0.35
  if (tenure !== 'unknown') score += 0.15
  if (staff !== null) score += 0.1
  if (years !== null) score += 0.1
  if (p.hasLocation) score += 0.1
  if (reason) score += 0.1
  if (p.priceKnown) score += 0.1

  const firstSentence = (s: string | undefined) => (s ? (s.split(/(?<=[.!?])\s/)[0] ?? s).slice(0, 220) : '')
  const [ka, en] = [p.texts.find((x) => /[ა-ჰ]/.test(x)), p.texts.find((x) => /[a-z]{3}/i.test(x) && !/[ა-ჰ]/.test(x))]

  return {
    source: 'text',
    assetClass: p.dealType === 'partnership' ? 'partnership' : p.category === 'land' ? 'land' : ['real_estate', 'commercial_space'].includes(p.category) ? 'real_estate' : 'operating_business',
    isOperating: CLOSED.test(text) ? false : OPERATING.test(text) ? true : null,
    operatingModel: 'unknown',
    skills: [],
    financials: { revenue_monthly: revenue, profit_monthly: profit, rent_income_monthly: rentIncome, other_figures: onRequest ? ['detailed financials (P&L) available on request'] : [] },
    premises: { tenure: rentPaid && tenure === 'unknown' ? 'leased' : tenure, rent_monthly: rentPaid, lease_terms: null, area_m2: area },
    staff: { count: staff, stays: null },
    includedAssets: included,
    locationHint: null,
    seasonality: null,
    reasonForSale: reason,
    yearsOperating: years,
    strengths,
    highlights: { ...highlights, onRequest },
    risks: [],
    redFlags: [],
    missingInfo: missing,
    sellerQuestions: [],
    summary: { ka: firstSentence(ka ?? en), en: firstSentence(en ?? ka), ru: firstSentence(en ?? ka) },
    completeness: Math.round(score * 100) / 100,
  }
}
