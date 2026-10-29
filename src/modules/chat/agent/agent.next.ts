import { pick } from '../../../shared/i18n/locale.js'
import { categoryLabel, cityLabel } from '../../catalog/catalog.labels.js'
import type { CatalogListing } from '../../catalog/catalog.model.js'
import { has, val } from '../profile/profile.model.js'
import { questions } from '../planner/planner.questions.js'
import type { QuickReply } from '../planner/planner.service.js'
import { CITIES } from './agent.fallback.js'
import { kindName, refOf, shortName } from './agent.facts.js'
import { inCity, NEXT, type NextKey } from './agent.next.labels.js'
import type { ToolContext } from './agent.tools.js'

// Two kinds of chips under an answer, always in this order: up to three answers to the assistant's closing question
// (the model's own), then up to two next steps with an icon, computed here from what is on screen and what this
// chat already answered — so they are there whatever the model felt like suggesting, and never repeat it.

export const MAX_NEXT = 2
export const MAX_MODEL_CHIPS = 3

const ICON: Record<NextKey, NonNullable<QuickReply['icon']>> = {
  compare: 'compare',
  location: 'location',
  risks: 'risk',
  price: 'market',
  calc: 'calc',
  seller: 'question',
  visit: 'check',
  similar: 'search',
  market: 'market',
  best: 'best',
  risks_each: 'risk',
  locations: 'location',
  show: 'search',
  district: 'location',
  check: 'check',
  market_sector: 'market',
  listings_sector: 'search',
  more: 'more',
}

// What a chip or a message is about. Two chips about the same thing are one chip; a topic just answered is not offered.
const TOPICS: [string, RegExp][] = [
  ['compare', /შეადარ|შედარებ|compare|сравн/i],
  ['best', /რომელი\s+(?:უფრო\s+)?(?:ჯობია|მირჩევ|ნაკლებად)|რას\s+მირჩევ|მირჩევდი|(?<!\p{L})რომელ\p{L}*\s+(?:\p{L}+\s+){0,2}(?:ნაკლებ|უკეთეს|ჯობ)|which (?:one |of these )?is (?:better|less)|what would you (?:recommend|choose|pick)|which would you|какой (?:из них )?(?:лучше|менее)|что (?:бы )?(?:вы )?посовету|что бы вы выбрали/iu],
  ['location', /ლოკაცი|მდებარეობ|კონკურენ|location|compet|локац|конкурен|располож/i],
  ['risks', /რისკ|risk|риск/i],
  ['profit', /მოგებ|ანაზღაურ|შემოსავ|სცენარ|profit|payback|income|прибыл|окупа|доход/i],
  ['seller', /გამყიდველ|ნომერ|seller|contact|продавц|номер/i],
  ['price', /ფას|ღირს|price|worth|цен|стоим/i],
  ['similar', /მსგავს|similar|похож/i],
  ['visit', /ადგილზე|დათვალიერ|on site|visit|на месте|осмотр/i],
]

export function topicsOf(text: string): string[] {
  return TOPICS.filter(([, re]) => re.test(text)).map(([k]) => k)
}

const TOPIC_OF_KEY: Partial<Record<NextKey, string>> = { listings_sector: 'search', compare: 'compare', best: 'best', risks_each: 'risks', locations: 'location', location: 'location', risks: 'risks', price: 'price', calc: 'profit', seller: 'seller', similar: 'similar', visit: 'visit' }
const TOPIC_OF_TOOL: Record<string, string> = { search_listings: 'search', compare_listings: 'compare', location_analysis: 'location', profit_scenarios: 'profit', calculate: 'profit', seller_message: 'seller', visit_checklist: 'visit' }
const ABOUT_ONE: NextKey[] = ['price', 'calc', 'seller', 'location', 'risks', 'visit', 'similar']

export type Offered = { key: string; text: string }

export function nextSteps(ctx: ToolContext, calledTools: string[], justClicked: string | null, modelChips: QuickReply[] = []): QuickReply[] {
  const { state, profile, locale } = ctx
  const called = new Set(calledTools)
  const shown = state.lastShown.map((id) => ctx.s.byId.get(id)).filter((l): l is CatalogListing => Boolean(l))
  const focus = (state.contextListingId && ctx.s.byId.get(state.contextListingId)) || (shown.length === 1 ? shown[0] : undefined)
  const city = val(profile, 'cities')?.[0] ?? focus?.city ?? null
  const sector = val(profile, 'sectors')?.[0] ?? focus?.category ?? null
  // "Show options" only once there is something to choose by: the kind of business, or "any" picked on purpose (an
  // empty list). With a budget alone the listings would be a random mix.
  const ready = has(profile, 'sectors') && has(profile, 'budgetGel') && (has(profile, 'goal') || has(profile, 'involvement'))

  // With two or more listings on screen the next step is about all of them; with one, about that one.
  let keys: NextKey[]
  if (shown.length >= 2 && !state.contextListingId) keys = called.has('compare_listings') ? ['best', 'risks_each', 'locations'] : ['compare', 'best', 'risks_each']
  else if (focus) keys = ['price', 'calc', 'seller', 'location', 'risks', 'visit']
  else if (ready) keys = ['show', 'check']
  else if (sector) keys = ['market_sector', 'listings_sector']
  else keys = []

  const answeredNow = new Set([...calledTools.map((t) => TOPIC_OF_TOOL[t]).filter(Boolean), ...topicsOf(ctx.userText ?? '')])
  const covered = new Set(focus ? (state.topics[focus.id] ?? []) : [])
  const taken = new Set(modelChips.flatMap((c) => topicsOf(c.label)))
  const lastTurn = new Set(state.nextShown.map((n) => n.key.replace(/^next:/, '')))
  const ref = focus ? `#${refOf(state, focus.id)} ${shortName(focus, locale)}` : ''
  const out: QuickReply[] = []
  for (const key of keys) {
    if (out.length === MAX_NEXT) break
    const topic = TOPIC_OF_KEY[key]
    if (key === justClicked) continue
    if (topic && (answeredNow.has(topic) || taken.has(topic))) continue
    if (topic && ABOUT_ONE.includes(key) && covered.has(topic === 'profit' ? 'profit' : topic)) continue
    if (lastTurn.has(key) && !called.size) continue // nothing changed since it was offered
    if ((key === 'market' || key === 'district' || key === 'market_sector' || key === 'listings_sector') && !(city || sector)) continue
    if (ABOUT_ONE.includes(key) && !focus) continue
    const vars = { ref, city: city ? inCity(cityLabel(city, locale), locale) : '', sector: sector ? categoryLabel(sector, locale) : '' }
    const fill = (s: string) => Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, v), s).replace(/\s{2,}/g, ' ').trim()
    const base = fill(pick(NEXT[key].label, locale))
    // "#2 საკონდიტრო — მოგება": a chip about one listing names it the way its card does.
    const label = ABOUT_ONE.includes(key) && focus ? `#${refOf(state, focus.id)} ${kindName(focus, locale)} — ${locale === 'ka' ? base : base.charAt(0).toLowerCase() + base.slice(1)}` : base
    if (key === 'show') out.push({ kind: 'action', id: `next:${key}`, label, action: 'show_results', icon: ICON[key] })
    else out.push({ kind: 'message', id: `next:${key}`, label, text: fill(pick(NEXT[key].text, locale)), icon: ICON[key] })
  }
  return out
}

// A yes/no closing question ("გავაკეთო #1-ის მოგების გათვლა?") gets the two obvious answers when the model offered none.
const YES_NO = /^(?:გსურთ|გინდათ|გავაკეთო|მოვამზადო|გაჩვენოთ|გაჩვენო|ვნახოთ|შევადარო|გამოვთვალო|გავაგრძელოთ|დავიწყოთ|შევამოწმო|მოგწეროთ|დაგეხმაროთ|shall i|should i|do you want|would you like|want me to|хотите|показать|сделать|подготовить|сравнить|посчитать|рассчитать|продолжим)/i
const YES = { ka: 'კი, გთხოვთ', en: 'Yes, please', ru: 'Да, пожалуйста' }
const NO = { ka: 'არა, სხვა რამე მაინტერესებს', en: 'No, something else', ru: 'Нет, другое' }

// "განვახორციელო თუ არა …?", "… or not?", "… или нет?" are yes/no questions whatever their first word. So is an
// offer that opens with a Georgian "shall I / shall we" verb ("გავაანალიზო #1-ის მდებარეობა?"), unless it asks what,
// which or how, or offers a choice ("#1 თუ #2?").
const OR_NOT = /(^|\s)თუ არა(\s|\?|$)|\bor not\b|или нет/i
const SHALL_I = /^[ა-ჰ]{4,}(ო|ოთ)[\s,]/
const OPEN_QUESTION = /(^|\s)(რა|რას|რომელ\S*|როგორ\S*|სად|როდის|რამდენ\S*|რატომ|ვინ|რისი|რით|თუ)(\s|\?|$)/

const isYesNo = (q: string) => YES_NO.test(q) || OR_NOT.test(q) || (SHALL_I.test(q) && !OPEN_QUESTION.test(q))

// "Any other questions?" moves nothing forward: no buttons for it.
const OPEN_ENDED = /სხვა\s+(?:შე)?კითხვ|other questions|anything else|другие вопросы|ещё вопрос|еще вопрос/i

export function yesNoChips(question: string | null, locale: 'ka' | 'en' | 'ru'): QuickReply[] {
  if (!question || OPEN_ENDED.test(question) || !isYesNo(question.trim())) return []
  return [
    { kind: 'message', id: 'ai:yes', label: YES[locale], text: YES[locale] },
    { kind: 'message', id: 'ai:no', label: NO[locale], text: NO[locale] },
  ]
}

// Any closing question with obvious answers gets them as buttons when the model offered none (round 6: "თბილისში თუ
// ბათუმში?" and "Сколько времени…?" had none): yes/no; the options of an either/or question; the form's own options
// for a question about time or the city.
export function answerChips(question: string | null, locale: 'ka' | 'en' | 'ru'): QuickReply[] {
  if (!question || OPEN_ENDED.test(question)) return []
  const q = question.trim()
  if (isYesNo(q)) return yesNoChips(q, locale)
  const message = (label: string, i: number): QuickReply => ({ kind: 'message', id: `ai:${i}`, label, text: label })
  const choices = choicesIn(q)
  if (choices.length) return choices.map(message)
  if (ASKS_TIME.test(q)) return (questions.find((x) => x.id === 'involvement')?.options ?? []).map((o, i) => message(pick(o.label, locale), i))
  if (ASKS_CITY.test(q)) return CITIES.filter(([c]) => ['Tbilisi', 'Batumi', 'any'].includes(c)).map(([, l], i) => message(pick(l, locale), i))
  return []
}

const ASKS_TIME = /დრო(?:ის|ს)?\s|საათ|დათმობ|ჩართულ|сколько времени|уделять|how much time|hands-on|how involved/i
const ASKS_CITY = /რომელ ქალაქ|რომელი ქალაქ|какой город|каком городе|which city/i
const OR = /\s(?:თუ|or|или)\s/i
const ASKS = /(^|\s)(რომელ\S*|რა|სად|which|what|where|какой|какие|какую|где|что)(\s|$)/i

// "თბილისში თუ ბათუმში?" → [თბილისში, ბათუმში]; "Тбилиси, Батуми или Кутаиси?" → three. The option before "or" has
// as many words as the one after it, unless a colon or dash sets it off. ", თუ …" is "if …", not a choice.
function choicesIn(q: string): string[] {
  const body = q.replace(/[*_]/g, '').replace(/\?\s*$/, '')
  const parts = body.split(OR)
  if (parts.length !== 2 || /,\s*$/.test(parts[0]!)) return []
  const right = parts[1]!.split(/[,;:]/)[0]!.trim()
  const n = right.split(/\s+/).length
  if (!right || n > 4) return []
  const set = parts[0]!.match(/[:—–]\s*([^:—–]*)$/)
  const items = (set ? set[1]! : parts[0]!).split(/,\s*/)
  // "რომელ ქალაქში ეძებთ, თბილისში თუ ბათუმში?": the part with the question word is the question, not an option.
  if (items.length > 1 && ASKS.test(items[0]!)) items.shift()
  else {
    const first = items[0]!.trim().split(/\s+/)
    items[0] = (set && first.length <= 4 ? first : first.slice(-n)).join(' ')
  }
  const options = [...items, right].map((o) => o.trim())
  const ok = options.length <= 3 && options.every((o) => o.length > 0 && o.length <= 40) && new Set(options).size === options.length
  return ok ? options : []
}

// Answers to the closing question first (at most three), then the next steps (at most two).
export function mergeChips(model: QuickReply[], next: QuickReply[]): QuickReply[] {
  return [...model.slice(0, MAX_MODEL_CHIPS), ...next.slice(0, MAX_NEXT)]
}

// The chip the user just tapped, by matching the message text to what was offered last turn.
export function clickedKey(offered: Offered[], userText: string): string | null {
  const hit = offered.find((o) => o.text === userText.trim())
  return hit ? hit.key.replace(/^next:/, '') : null
}

export function offeredFrom(chips: QuickReply[]): Offered[] {
  return chips.filter((c) => c.id.startsWith('next:')).map((c) => ({ key: c.id, text: c.kind === 'message' ? c.text : c.label }))
}
