import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clickedKey, mergeChips, nextSteps, offeredFrom } from '../src/modules/chat/agent/agent.next.js'
import type { ToolContext } from '../src/modules/chat/agent/agent.tools.js'
import { sessionStateSchema } from '../src/modules/chat/chat.model.js'
import type { CatalogListing } from '../src/modules/catalog/catalog.model.js'

// The next-step chips under an answer depend on what the turn did and what is on screen; no model, no network.

const listing = (id: string, title: string, category = 'restaurants'): CatalogListing =>
  ({ id, shortId: id.slice(0, 8), title: { ka: title, en: title, ru: title }, category, city: 'Tbilisi', district: null, latitude: null, longitude: null, address: null, insights: null, images: [] }) as unknown as CatalogListing

const a = listing('aaaaaaaa-0000-4000-8000-000000000001', 'კაფე ვაკეში')
const b = listing('bbbbbbbb-0000-4000-8000-000000000002', 'საცხობი საბურთალოზე', 'bakery')

function ctx(over: Partial<{ lastShown: string[]; contextListingId: string; aspectsAsked: string[]; nextShown: { key: string; text: string }[]; profile: Record<string, unknown> }> = {}): ToolContext {
  const state = sessionStateSchema.parse({ lastShown: over.lastShown ?? [], contextListingId: over.contextListingId, aspectsAsked: over.aspectsAsked ?? [], nextShown: over.nextShown ?? [] })
  return {
    s: { byId: new Map([[a.id, a], [b.id, b]]), cities: ['Tbilisi'], categories: ['restaurants', 'bakery'], listings: [a, b] } as unknown as ToolContext['s'],
    sessionId: 'test',
    turn: 1,
    locale: 'ka',
    profile: (over.profile ?? {}) as ToolContext['profile'],
    state,
    out: { cards: [], compare: null, sources: [], quickReplies: [], form: null },
    progress: async () => {},
  }
}
const keys = (chips: ReturnType<typeof nextSteps>) => chips.map((c) => c.id.replace('next:', ''))

test('two listings shown: compare first, then location and risks of the first one, with icons', () => {
  const chips = nextSteps(ctx({ lastShown: [a.id, b.id] }), ['search_listings'], null)
  assert.deepEqual(keys(chips), ['compare', 'location', 'risks'])
  assert.ok(chips.every((c) => c.icon), 'every next step carries an icon')
  const location = chips[1]!
  assert.equal(location.kind, 'message')
  assert.match(location.kind === 'message' ? location.text : '', /«კაფე ვაკეში» \[aaaaaaaa\]/, 'the message names the listing so the model can resolve it')
})

test('listing in focus: aspects already analysed are not offered again', () => {
  const chips = nextSteps(ctx({ lastShown: [a.id], contextListingId: a.id, aspectsAsked: ['risks', 'competition'] }), ['analyze_listing'], null)
  assert.deepEqual(keys(chips), ['price', 'calc', 'seller'])
})

test('nothing on screen and an empty profile: no next steps', () => {
  assert.deepEqual(nextSteps(ctx(), [], null), [])
})

test('profile complete but no results yet: offer to show options, as the action chip', () => {
  const profile = { budgetGel: { value: 50000, status: 'known', turn: 1 }, goal: { value: 'passive_income', status: 'known', turn: 1 }, cities: { value: ['Tbilisi'], status: 'known', turn: 1 } }
  const chips = nextSteps(ctx({ profile }), ['update_profile'], null)
  assert.equal(chips[0]?.kind, 'action')
  assert.deepEqual(keys(chips), ['show', 'market', 'check'])
  assert.match(chips[1]!.label, /თბილისში/, 'the city is named in the locative')
})

test('after a comparison: which is better, risks of each, compare locations', () => {
  assert.deepEqual(keys(nextSteps(ctx({ lastShown: [a.id, b.id] }), ['compare_listings'], null)), ['best', 'risks_each', 'locations'])
})

test('the chip just tapped is not offered again, and model chips come first, at most five in all', () => {
  const offered = offeredFrom(nextSteps(ctx({ lastShown: [a.id, b.id] }), ['search_listings'], null))
  const clicked = clickedKey(offered, 'შეადარე ნაჩვენები ვარიანტები ერთმანეთს')
  assert.equal(clicked, 'compare')
  const next = nextSteps(ctx({ lastShown: [a.id, b.id], nextShown: offered }), ['compare_listings'], clicked)
  assert.ok(!keys(next).includes('compare'))
  const model = ['კი', 'არა', 'მოგვიანებით', 'სხვა'].map((o, i) => ({ kind: 'message' as const, id: `ai:${i}`, label: o, text: o }))
  const merged = mergeChips(model, next)
  assert.equal(merged.length, 5)
  assert.ok(merged.slice(0, 3).every((c) => c.id.startsWith('ai:')))
})
