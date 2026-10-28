// Money amounts in a message, each with what it refers to. Only an amount the user states as money they
// have to invest is a budget; a listing price, a seller's profit or turnover, or rent never is.
// "მაქვს 50 000 ლარი" → budget · "ბიზნესი 40 000 ლარი ღირს" → price · "თვეში 2500 ლარი მოგება" → profit, monthly.

export type AmountRole = 'budget' | 'price' | 'profit' | 'revenue' | 'rent' | 'expenses' | 'unknown'
export type Currency = 'GEL' | 'USD' | 'EUR'
export type Amount = { value: number; currency: Currency; role: AmountRole; period: 'month' | 'year' | null }

const NUMBER = /(\d{1,3}(?:[ ,.]\d{3})+|\d+(?:[.,]\d+)?)\s*([a-zA-Zა-ჿЀ-ӿ$€₾]+)?/g
const THOUSAND = /^(k|к|კ|ათას\S*|тыс\S*|thousand|grand)$/i
const MILLION = /^(m|mln|million|მლნ|მილიონ\S*|млн|миллион\S*)$/i
const CURRENCY: [RegExp, Currency][] = [
  [/\$|usd|dollar|დოლარ|доллар|бакс/i, 'USD'],
  [/€|eur|ევრო|евро/i, 'EUR'],
  [/₾|gel|lari|ლარ|лар/i, 'GEL'],
]

// Words that say what an amount is. The nearest cue to the number wins.
const ROLE_CUES: [AmountRole, RegExp][] = [
  ['profit', /მოგებ|წმინდა|profit|net income|прибыл|чист\S* доход/gi],
  ['revenue', /ბრუნვ|შემოსავ|გაყიდვებ|revenue|turnover|sales|выручк|оборот|доход/gi],
  ['rent', /ქირ|იჯარ|\brent|аренд/gi],
  ['expenses', /ხარჯ|expens|costs per|расход|затрат/gi],
  ['price', /ღირს|ფას|იყიდება|\bcosts?\b|\bprice|priced|asking|стоит|цен|продаётся|продается/gi],
  ['budget', /ბიუჯეტ|მაქვს|მაქ\b|ჩავდო|ჩადებ|ინვესტ|დავხარჯო|budget|i have|i've got|invest|up to|under|my capital|бюджет|у меня|есть\s|вложить|инвест|до\s/gi],
]
const MONTH = /თვეში|თვიურ|ყოველთვიურ|თვის\b|monthly|per month|a month|\/\s?month|в месяц|ежемесяч|месячн/i
const YEAR = /წელიწადში|წლიურ|წელს|წლის\b|annual|yearly|per year|a year|\/\s?year|в год|годов|за год/i
const WINDOW = 40 // characters around the number that can describe it
// An amount is described only by its own clause: "40 000 ლარი ღირს და თვეში 2500 ლარი მოგებაა" has two.
const CLAUSE_END = /[.;!?]|,\s|\s(და|და\s+თუ|and|but|while|и|а|но)\s/i

function parseNumber(raw: string): number {
  return Number(raw.replace(/[ ,](?=\d{3})/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'))
}

export function extractAmounts(text: string): Amount[] {
  const out: Amount[] = []
  for (const m of text.matchAll(NUMBER)) {
    const start = m.index!
    let value = parseNumber(m[1]!)
    // The word after the number is a unit only if it is a multiplier or a currency ("50k", "50 000 ლარამდე").
    const word = m[2] ?? ''
    const isUnit = THOUSAND.test(word.replace(/[$€₾]/g, '')) || MILLION.test(word.replace(/[$€₾]/g, '')) || CURRENCY.some(([p]) => p.test(word))
    const unit = isUnit ? word : ''
    const end = isUnit ? start + m[0].length : start + m[1]!.length
    const multiplier = unit.replace(/[$€₾]/g, '')
    if (THOUSAND.test(multiplier)) value *= 1_000
    else if (MILLION.test(multiplier)) value *= 1_000_000
    if (!Number.isFinite(value) || value < 100 || value > 100_000_000) continue

    const rawBefore = text.slice(Math.max(0, start - WINDOW), start)
    const rawAfter = text.slice(end, end + WINDOW)
    const cut = [...rawBefore.matchAll(new RegExp(CLAUSE_END, 'gi'))].at(-1)
    const before = cut ? rawBefore.slice(cut.index! + cut[0].length) : rawBefore
    const after = rawAfter.slice(0, rawAfter.search(CLAUSE_END) === -1 ? undefined : rawAfter.search(CLAUSE_END))
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
    const context = `${before} ${after}`
    const period = MONTH.test(context) ? 'month' : YEAR.test(context) ? 'year' : null
    out.push({ value, currency: currency ?? 'GEL', role, period })
  }
  return out
}
