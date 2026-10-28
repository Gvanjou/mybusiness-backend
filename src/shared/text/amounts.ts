// Money amounts in a message, each with what it refers to. Only an amount the user states as money they
// have to invest is a budget; a listing price, a seller's profit or turnover, or rent never is.
// "მაქვს 50 000 ლარი" → budget · "ბიზნესი 40 000 ლარი ღირს" → price · "თვეში 2500 ლარი მოგება" → profit, monthly.

export type AmountRole = 'budget' | 'price' | 'profit' | 'revenue' | 'rent' | 'expenses' | 'unknown'
export type Currency = 'GEL' | 'USD' | 'EUR'
export type Period = 'day' | 'week' | 'month' | 'year'
// value is the amount as written; max the upper end of a range ("700-800 ლარი" → 700, max 800).
export type Amount = { value: number; max?: number; currency: Currency; role: AmountRole; period: Period | null }

const DIGITS = String.raw`\d{1,3}(?:[ ,.]\d{3})+|\d+(?:[.,]\d+)?`
// A number, an optional second number that makes it a range, then the word after it (a unit or currency).
const NUMBER = new RegExp(String.raw`(${DIGITS})(?:\s*[-–—]\s*(${DIGITS}))?\s*([a-zA-Zა-ჿЀ-ӿ$€₾]+)?`, 'g')
const THOUSAND = /^(k|к|კ|ათას\S*|тыс\S*|thousand|grand)$/i
const MILLION = /^(m|mln|million|მლნ|მილიონ\S*|млн|миллион\S*)$/i
const CURRENCY: [RegExp, Currency][] = [
  [/\$|usd|dollar|დოლარ|აშშ|доллар|бакс/i, 'USD'],
  [/€|eur|ევრო|евро/i, 'EUR'],
  [/₾|gel|lari|ლარ|лар/i, 'GEL'],
]

// Words that say what an amount is. The nearest cue to the number wins.
const ROLE_CUES: [AmountRole, RegExp][] = [
  ['profit', /მოგებ|წმინდა|profit|net income|прибыл|чист\S* доход/gi],
  ['revenue', /ბრუნვ|შემოსავ|გაყიდვებ|revenue|turnover|sales|выручк|оборот|доход/gi],
  ['rent', /ქირ|იჯარ|\brent|аренд/gi],
  ['expenses', /ხარჯ|expens|costs per|расход|затрат/gi],
  // "იჯარის ფასი" / "rent price" is the rent, not the asking price.
  ['price', /ღირს|(?<!(?:იჯარ|ქირ)\S*\s)ფას|იყიდება|\bcosts?\b|(?<!rent(?:al)?\s)\bprice|priced|asking|стоит|цен|продаётся|продается/gi],
  ['budget', /ბიუჯეტ|მაქვს|მაქ\b|ჩავდო|ჩადებ|ინვესტ|დავხარჯო|budget|i have|i've got|invest|up to|under|my capital|бюджет|у меня|есть\s|вложить|инвест|до\s/gi],
]
// The period an amount is per; the nearest cue wins ("დღიური ბრუნვა 700-800 ლარი" is per day, not per month).
// "ყოველდღიურად" (every day) says when a place is open, not what a figure is per.
const PERIODS: [Period, RegExp][] = [
  ['day', /(?<!ყოველ)დღიურ|დღეში|დღე-ღამეში|per day|a day\b|\bdaily\b|\/\s?day|в день|за день|в сутки/gi],
  ['week', /კვირაში|per week|a week\b|\bweekly\b|в неделю|еженедельн/gi],
  ['month', /თვეში|თვიურ|ყოველთვიურ|თვის\b|monthly|per month|a month|\/\s?month|в месяц|ежемесяч|месячн/gi],
  ['year', /წელიწადში|წლიურ|წელს|წლის\b|annual|yearly|per year|a year|\/\s?year|в год|годов|за год/gi],
]
const WINDOW = 40 // characters around the number that can describe it
// An amount is described only by its own clause: "40 000 ლარი ღირს და თვეში 2500 ლარი მოგებაა" has two.
// A new line too: listings put one fact per line ("💰 ფასი: 140 000 ლარი" / "💰 თვიური იჯარა: 9 500 ლარი").
const CLAUSE_END = /[.;!?\n]|,\s|\s(და|და\s+თუ|and|but|while|и|а|но)\s/i
// After a number a dash or bar starts the next fact ("ბრუნვა 700 000 ლარი - ფასი - 25 000$"); before one it joins a
// label to its value ("ქირა — 500 $ თვეში"). A range was already read as one number.
const AFTER_END = new RegExp(`${CLAUSE_END.source}|\\s[-–—|]\\s`, 'i')

function parseNumber(raw: string): number {
  return Number(raw.replace(/[ ,](?=\d{3})/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'))
}

export function extractAmounts(text: string): Amount[] {
  const out: Amount[] = []
  for (const m of text.matchAll(NUMBER)) {
    const start = m.index!
    let value = parseNumber(m[1]!)
    let max = m[2] ? parseNumber(m[2]) : undefined
    // The word after the number is a unit only if it is a multiplier or a currency ("50k", "50 000 ლარამდე").
    const word = m[3] ?? ''
    const isUnit = THOUSAND.test(word.replace(/[$€₾]/g, '')) || MILLION.test(word.replace(/[$€₾]/g, '')) || CURRENCY.some(([p]) => p.test(word))
    const unit = isUnit ? word : ''
    // Without a unit the number (or range) ends before the space, so a clause word right after it still counts.
    const end = isUnit ? start + m[0].length : start + m[0].slice(0, m[0].length - word.length).trimEnd().length
    const multiplier = unit.replace(/[$€₾]/g, '')
    const scale = THOUSAND.test(multiplier) ? 1_000 : MILLION.test(multiplier) ? 1_000_000 : 1
    value *= scale
    if (max !== undefined) max *= scale
    // A real range runs upward and stays within a few times its start; anything else is two unrelated numbers.
    if (max !== undefined && !(max > value && max <= value * 5)) max = undefined
    if (!Number.isFinite(value) || value < 100 || value > 100_000_000) continue

    const rawBefore = text.slice(Math.max(0, start - WINDOW), start)
    const rawAfter = text.slice(end, end + WINDOW)
    const cut = [...rawBefore.matchAll(new RegExp(CLAUSE_END, 'gi'))].at(-1)
    const before = cut ? rawBefore.slice(cut.index! + cut[0].length) : rawBefore
    const after = rawAfter.slice(0, rawAfter.search(AFTER_END) === -1 ? undefined : rawAfter.search(AFTER_END))
    const near = `${unit} ${after.slice(0, 12)}`
    const currency = CURRENCY.find(([p]) => p.test(near) || p.test(rawBefore.slice(-3)))?.[1]

    // "50 000 ლარამდე" / "up to 50k": the unit itself can carry the budget cue.
    let role: AmountRole = /მდე$|მდე\b/.test(unit) ? 'budget' : 'unknown'
    if (role === 'unknown') {
      let best = Infinity
      for (const [r, cue] of ROLE_CUES) {
        for (const c of before.matchAll(cue)) {
          const d = before.length - c.index!
          if (d < best) [best, role] = [d, r]
        }
        for (const c of after.matchAll(cue)) {
          const d = c.index! + 1
          if (d < best) [best, role] = [d, r]
        }
      }
    }
    // A bare number is money only with a currency or a cue ("2-3 საათი" is not an amount).
    if (!currency && role === 'unknown') continue
    let period: Period | null = null
    let nearest = Infinity
    for (const [p, cue] of PERIODS) {
      for (const c of before.matchAll(cue)) if (before.length - c.index! < nearest) [nearest, period] = [before.length - c.index!, p]
      for (const c of after.matchAll(cue)) if (c.index! + 1 < nearest) [nearest, period] = [c.index! + 1, p]
    }
    out.push({ value, ...(max !== undefined ? { max } : {}), currency: currency ?? 'GEL', role, period })
  }
  return out
}
