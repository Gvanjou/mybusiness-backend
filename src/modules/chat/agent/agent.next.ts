import { pick } from '../../../shared/i18n/locale.js'
import { categoryLabel, cityLabel } from '../../catalog/catalog.labels.js'
import type { CatalogListing } from '../../catalog/catalog.model.js'
import { has, val } from '../profile/profile.model.js'
import type { QuickReply } from '../planner/planner.service.js'
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
  ['best', /რომელი\s+(?:უფრო\s+)?(?:ჯობია|მირჩევ|ნაკლებად)|which (?:one |of these )?is (?:better|less)|какой (?:из них )?(?:лучше|менее)/i],
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

const TOPIC_OF_KEY: Partial<Record<NextKey, string>> = { compare: 'compare', best: 'best', risks_each: 'risks', locations: 'location', location: 'location', risks: 'risks', price: 'price', calc: 'profit', seller: 'seller', similar: 'similar', visit: 'visit' }
const TOPIC_OF_TOOL: Record<string, string> = { compare_listings: 'compare', location_analysis: 'location', profit_scenarios: 'profit', calculate: 'profit', seller_message: 'seller', visit_checklist: 'visit' }
const ABOUT_ONE: NextKey[] = ['price', 'calc', 'seller', 'location', 'risks', 'visit', 'similar']

export type Offered = { key: string; text: string }

export function nextSteps(ctx: ToolContext, calledTools: string[], justClicked: string | null, modelChips: QuickReply[] = []): QuickReply[] {
  const { state, profile, locale } = ctx
  const called = new Set(calledTools)
  const shown = state.lastShown.map((id) => ctx.s.byId.get(id)).filter((l): l is CatalogListing => Boolean(l))
  const focus = (state.contextListingId && ctx.s.byId.get(state.contextListingId)) || (shown.length === 1 ? shown[0] : undefined)
  const city = val(profile, 'cities')?.[0] ?? focus?.city ?? null
  const sector = val(profile, 'sectors')?.[0] ?? focus?.category ?? null
  const ready = has(profile, 'budgetGel') && (has(profile, 'goal') || has(profile, 'involvement'))

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
