import { pick } from '../../../shared/i18n/locale.js'
import { categoryLabel, cityLabel } from '../../catalog/catalog.labels.js'
import type { CatalogListing } from '../../catalog/catalog.model.js'
import { has, val } from '../profile/profile.model.js'
import type { QuickReply } from '../planner/planner.service.js'
import { inCity, NEXT, type NextKey } from './agent.next.labels.js'
import type { ToolContext } from './agent.tools.js'

// The logical next steps after an answer, offered as chips with an icon (compare, risks, location, market
// prices, payback…). Computed here from what the turn did and what is on screen, so they are there whatever
// the model felt like suggesting. The model's own chips (answers to its one question) come first.

export const MAX_NEXT = 3
export const MAX_MODEL_CHIPS = 3
export const MAX_CHIPS = 5 // more than this and the row stops reading as a choice

const ICON: Record<NextKey, NonNullable<QuickReply['icon']>> = {
  compare: 'compare',
  location: 'location',
  risks: 'risk',
  price: 'market',
  calc: 'calc',
  seller: 'question',
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

// Which analysis aspect a chip asks for, so one already answered for the listing in focus is not offered again.
const ASPECT: Partial<Record<NextKey, string>> = { risks: 'risks', location: 'competition', price: 'price', seller: 'seller_questions', similar: 'similar', calc: 'price' }

export type Offered = { key: string; text: string }

export function nextSteps(ctx: ToolContext, calledTools: string[], justClicked: string | null): QuickReply[] {
  const { state, profile, locale } = ctx
  const called = new Set(calledTools)
  const shown = state.lastShown.map((id) => ctx.s.byId.get(id)).filter((l): l is CatalogListing => Boolean(l))
  const focus = (state.contextListingId && ctx.s.byId.get(state.contextListingId)) || shown[0]
  const first = shown[0]
  const city = val(profile, 'cities')?.[0] ?? focus?.city ?? null
  const sector = val(profile, 'sectors')?.[0] ?? focus?.category ?? null
  const ready = has(profile, 'budgetGel') && (has(profile, 'goal') || has(profile, 'involvement'))

  let keys: NextKey[]
  if (called.has('compare_listings')) keys = ['best', 'risks_each', 'locations']
  else if (called.has('location_analysis')) keys = ['market', 'risks', 'calc']
  else if (called.has('market_stats')) keys = ['show', 'district']
  else if (called.has('calculate')) keys = ['check', 'seller']
  else if (called.has('search_listings') && shown.length >= 2) keys = ['compare', 'location', 'risks', 'market']
  else if (called.has('search_listings') && shown.length === 1) keys = ['risks', 'location', 'calc', 'market']
  else if ((called.has('get_listing') || called.has('analyze_listing')) && focus) keys = ['risks', 'location', 'price', 'calc', 'seller', 'similar']
  else if (shown.length === 0 && ready) keys = ['show', 'market', 'check']
  else if (shown.length === 0 && sector) keys = ['market_sector', 'listings_sector']
  else if (focus) keys = ['risks', 'location', 'calc', 'seller']
  else keys = []

  const asked = new Set(focus && state.contextListingId === focus.id ? state.aspectsAsked : [])
  const lastTurn = new Set(state.nextShown.map((n) => n.key))
  const out: QuickReply[] = []
  for (const key of keys) {
    if (out.length === MAX_NEXT) break
    if (key === justClicked) continue
    const aspect = ASPECT[key]
    if (aspect && asked.has(aspect)) continue
    if (lastTurn.has(key) && !called.size) continue // nothing changed since it was offered
    if ((key === 'market' || key === 'district' || key === 'market_sector' || key === 'listings_sector') && !(city || sector)) continue
    if (['location', 'risks', 'price', 'calc', 'seller', 'similar'].includes(key) && !(focus || first)) continue
    const target = (called.has('search_listings') ? first : focus) ?? first
    const vars = {
      ref: target ? `«${pick(target.title, locale)}» [${target.shortId}]` : '',
      city: city ? inCity(cityLabel(city, locale), locale) : '',
      sector: sector ? categoryLabel(sector, locale) : '',
    }
    const fill = (s: string) => Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, v), s).replace(/\s{2,}/g, ' ').trim()
    const label = fill(pick(NEXT[key].label, locale))
    if (key === 'show') out.push({ kind: 'action', id: `next:${key}`, label, action: 'show_results', icon: ICON[key] })
    else out.push({ kind: 'message', id: `next:${key}`, label, text: fill(pick(NEXT[key].text, locale)), icon: ICON[key] })
  }
  return out
}

// Model chips first (capped), then the app's next steps, five in all at most.
export function mergeChips(model: QuickReply[], next: QuickReply[]): QuickReply[] {
  const own = model.slice(0, MAX_MODEL_CHIPS)
  return [...own, ...next.slice(0, Math.max(0, MAX_CHIPS - own.length))]
}

// The chip the user just tapped, by matching the message text to what was offered last turn.
export function clickedKey(offered: Offered[], userText: string): string | null {
  const hit = offered.find((o) => o.text === userText.trim())
  return hit ? hit.key.replace(/^next:/, '') : null
}

export function offeredFrom(chips: QuickReply[]): Offered[] {
  return chips.filter((c) => c.id.startsWith('next:')).map((c) => ({ key: c.id, text: c.kind === 'message' ? c.text : c.label }))
}

