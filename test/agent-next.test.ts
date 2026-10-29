import assert from 'node:assert/strict'
import { test } from 'node:test'
import { answerChips, clickedKey, mergeChips, nextSteps, offeredFrom, topicsOf, yesNoChips } from '../src/modules/chat/agent/agent.next.js'
import { emptyOutput, type ToolContext } from '../src/modules/chat/agent/agent.tools.js'
import { sessionStateSchema } from '../src/modules/chat/chat.model.js'
import type { CatalogListing } from '../src/modules/catalog/catalog.model.js'

// The next-step chips under an answer depend on what is on screen and what this chat already answered; no model,
// no network.

const listing = (id: string, title: string, category = 'restaurants'): CatalogListing =>
  ({ id, shortId: id.slice(0, 8), title: { ka: title, en: title, ru: title }, category, city: 'Tbilisi', district: null, latitude: null, longitude: null, address: null, area: null, insights: null, images: [], description: { original: '', en: null } }) as unknown as CatalogListing

const a = listing('aaaaaaaa-0000-4000-8000-000000000001', 'კაფე ვაკეში')
const b = listing('bbbbbbbb-0000-4000-8000-000000000002', 'საცხობი საბურთალოზე', 'bakery')

type Over = Partial<{ lastShown: string[]; contextListingId: string; topics: Record<string, string[]>; nextShown: { key: string; text: string }[]; profile: Record<string, unknown>; userText: string }>

function ctx(over: Over = {}): ToolContext {
  const state = sessionStateSchema.parse({ lastShown: over.lastShown ?? [], contextListingId: over.contextListingId, topics: over.topics ?? {}, nextShown: over.nextShown ?? [], refs: [a.id, b.id] })
  return {
    s: { byId: new Map([[a.id, a], [b.id, b]]), cities: ['Tbilisi'], categories: ['restaurants', 'bakery'], listings: [a, b] } as unknown as ToolContext['s'],
    sessionId: 'test',
    turn: 1,
    locale: 'ka',
    profile: (over.profile ?? {}) as ToolContext['profile'],
    state,
    out: emptyOutput(),
    progress: async () => {},
    userText: over.userText ?? '',
  }
}
const keys = (chips: ReturnType<typeof nextSteps>) => chips.map((c) => c.id.replace('next:', ''))

test('two or more listings on screen: compare and "which is better for me", with icons, at most two', () => {
  const chips = nextSteps(ctx({ lastShown: [a.id, b.id] }), ['search_listings'], null)
  assert.deepEqual(keys(chips), ['compare', 'best'])
  assert.ok(chips.every((c) => c.icon), 'every next step carries an icon')
})

test('one listing: never "compare" or "which is better"; price, profit, the seller — named by number', () => {
  const chips = nextSteps(ctx({ lastShown: [a.id] }), ['search_listings'], null)
  assert.deepEqual(keys(chips), ['price', 'calc'])
  assert.equal(chips[0]!.label, '#1 კაფე — ფასი მსგავსებთან')
  assert.match(chips[1]!.kind === 'message' ? chips[1]!.text : '', /#1 კაფე, ვაკე/, 'the message names the listing as the text does')
})

test('topics already answered for the listing, or just now, are not offered again', () => {
  const chips = nextSteps(ctx({ lastShown: [a.id], contextListingId: a.id, topics: { [a.id]: ['price', 'profit'] } }), ['analyze_listing'], null)
  assert.deepEqual(keys(chips), ['seller', 'location'])
  const afterRisks = nextSteps(ctx({ lastShown: [a.id], contextListingId: a.id, topics: { [a.id]: ['price', 'profit', 'seller'] }, userText: 'რა რისკებია?' }), [], null)
  assert.ok(!keys(afterRisks).includes('risks'), 'a risks answer is not followed by a risks chip')
})

test('no two chips mean the same thing: the model already offered the location', () => {
  const model = [{ kind: 'message' as const, id: 'ai:0', label: 'კი, ლოკაციაც შევამოწმოთ', text: 'კი' }]
  const chips = nextSteps(ctx({ lastShown: [a.id], contextListingId: a.id, topics: { [a.id]: ['price', 'profit', 'seller'] } }), [], null, model)
  assert.ok(!keys(chips).includes('location'))
  assert.deepEqual(topicsOf('ლოკაცია და კონკურენცია'), ['location'])
})

test('nothing on screen and an empty profile: no next steps', () => {
  assert.deepEqual(nextSteps(ctx(), [], null), [])
})

test('enough to choose by but no results yet: offer to show options, as the action chip; a budget alone is not enough', () => {
  const base = { budgetGel: { value: 50000, status: 'known', turn: 1 }, goal: { value: 'passive_income', status: 'known', turn: 1 }, cities: { value: ['Tbilisi'], status: 'known', turn: 1 } }
  assert.ok(!keys(nextSteps(ctx({ profile: base }), ['update_profile'], null)).includes('show'), 'no kind of business: the listings would be a random mix')
  const profile = { ...base, sectors: { value: ['restaurants'], status: 'known', turn: 1 } }
  const chips = nextSteps(ctx({ profile }), ['update_profile'], null)
  assert.equal(chips[0]?.kind, 'action')
  assert.deepEqual(keys(chips), ['show', 'check'])
})

test('after a comparison: which is better and the risks of each', () => {
  assert.deepEqual(keys(nextSteps(ctx({ lastShown: [a.id, b.id] }), ['compare_listings'], null)), ['best', 'risks_each'])
})

test('the chip just tapped is not offered again; answers come first (three at most), then two next steps', () => {
  const offered = offeredFrom(nextSteps(ctx({ lastShown: [a.id, b.id] }), ['search_listings'], null))
  const clicked = clickedKey(offered, 'შეადარე ნაჩვენები ვარიანტები ერთმანეთს')
  assert.equal(clicked, 'compare')
  const next = nextSteps(ctx({ lastShown: [a.id, b.id], nextShown: offered }), ['search_listings'], clicked)
  assert.ok(!keys(next).includes('compare'))
  const model = ['კი', 'არა', 'მოგვიანებით', 'სხვა'].map((o, i) => ({ kind: 'message' as const, id: `ai:${i}`, label: o, text: o }))
  const merged = mergeChips(model, next)
  assert.equal(merged.filter((c) => c.id.startsWith('ai:')).length, 3)
  assert.ok(merged.slice(0, 3).every((c) => c.id.startsWith('ai:')))
  assert.ok(merged.length <= 5)
})

test('asking for a recommendation counts as "which is better"; "any other questions?" gets no buttons', () => {
  assert.ok(topicsOf('შენ რას მირჩევდი, რომელში არის უფრო ნაკლები რისკი და კონკურენცია?').includes('best'))
  assert.ok(topicsOf('What would you recommend?').includes('best'))
  assert.deepEqual(answerChips('გაქვთ თუ არა სხვა შეკითხვები?', 'ka'), [])
  assert.deepEqual(yesNoChips('Do you have any other questions?', 'en'), [])
  assert.equal(answerChips('გავაკეთო #2-ის მოგების გათვლა?', 'ka').length, 2, 'a real offer still gets yes and no')
})
