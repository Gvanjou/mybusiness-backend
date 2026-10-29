import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { ai } from '../src/modules/ai/ai.gateway.js'
import { catalog, toListing, type CatalogSnapshot } from '../src/modules/catalog/catalog.service.js'
import { agentTurn } from '../src/modules/chat/agent/agent.service.js'
import { factSheet } from '../src/modules/chat/agent/agent.facts.js'
import { emptyOutput, runTool, toolsFor, type ToolContext } from '../src/modules/chat/agent/agent.tools.js'
import { sessionStateSchema } from '../src/modules/chat/chat.model.js'
import { chatRepository, type Session, type StoredMessage } from '../src/modules/chat/chat.repository.js'

// The prompt goes with every model call (two a turn): it stays small without losing a fact the answer rules rely on.
// Listings are in memory and the model is scripted, so no network and no Gemini quota.

const rates = { GEL: 1, USD: 2.6, EUR: 2.9 }
const make = (n: number, extra: Record<string, unknown> = {}) =>
  toListing({ id: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`, title: `კაფე ${n}`, category: 'restaurants', deal_type: 'sale', price: 20000 + n * 1000, currency: 'GEL', city: 'Tbilisi', description: '', ...extra }, rates)
const listings = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => make(n, n === 1 ? { description: 'მოქმედი კაფე, ქირა 450$ თვეში' } : {}))
// Filed under bakery, but the title says café; and one filed as "other" with no clearer name.
const cafeAsBakery = make(9, { title: 'სრულად აღჭურვილი კაფე, ვერა', category: 'bakery' })
const vague = make(10, { title: 'იყიდება ბიზნესი', category: 'other' })
listings.push(cafeAsBakery, vague)
const snapshot = { listings, byId: new Map(listings.map((l) => [l.id, l])), byShortId: new Map(listings.map((l) => [l.shortId, l])), stats: new Map(), cities: ['Tbilisi'], categories: ['restaurants'], rates, loadedAt: new Date() } as unknown as CatalogSnapshot
const ids = listings.map((l) => l.id)

test('a fact sheet carries only what the listing states, names the rest once, and has no competitors line until the map is read', () => {
  const sheet = factSheet(listings[0]!, snapshot, sessionStateSchema.parse({ refs: ids }), 'ka', 100000) as Record<string, string>
  assert.match(sheet.rent!, /\$450/)
  assert.match(sheet.status!, /მოქმედი/)
  assert.equal(sheet.not_stated, 'area, turnover, profit, staff, years_open, reason_for_sale')
  assert.ok(!Object.values(sheet).some((v) => /არ არის მითითებული/.test(v)), 'no "not stated" values')
  assert.equal(sheet.competitors, undefined)
  assert.equal(sheet.budget, undefined, 'within the budget: no line')
  assert.match((factSheet(listings[0]!, snapshot, sessionStateSchema.parse({ refs: ids }), 'ka', 10000) as Record<string, string>).budget!, /აღემატება/, 'over the budget: said, with the amount')
})

const ctxOf = (profile: Session['profile'] = {}, earlier: ToolContext['earlier'] = []): ToolContext => ({ s: snapshot, sessionId: 's', userId: null, turn: 2, locale: 'ka', profile, state: sessionStateSchema.parse({ refs: ids }), out: emptyOutput(), progress: async () => {}, userText: 'კაფე მინდა', earlier })
const known = <T>(value: T) => ({ value, status: 'known' as const, turn: 1 })

test('only tools that can run are offered: no form once the key facts are known, no earlier chats when there are none', () => {
  const names = (ctx: ToolContext) => toolsFor(ctx).map((t) => t.name)
  assert.ok(names({ ...ctxOf(), userText: 'მინდა ფულის ჩადება, არ ვიცი რაში' }).includes('show_form'), 'nothing to go on yet: the form is offered')
  assert.ok(!names(ctxOf()).includes('show_form'), '"კაფე მინდა": enough to search on, no form')
  assert.ok(!names(ctxOf({ budgetGel: known(50000), cities: known(['Tbilisi']), involvement: known('part_time') })).includes('show_form'))
  assert.ok(!names(ctxOf()).includes('recall_previous_chats'))
  assert.ok(names(ctxOf({}, [{ id: 'x', title: 't', updatedAt: '', profile: {}, listings: [] }] as unknown as ToolContext['earlier'])).includes('recall_previous_chats'))
})

test('a business type written as a name instead of a key is still understood ("cafe" → restaurants)', async () => {
  const ctx = ctxOf()
  await runTool('update_profile', { sectors: ['cafe'] }, ctx)
  assert.deepEqual(ctx.profile.sectors?.value, ['restaurants'])
})

// ── The whole request, with a scripted model ──

type Step = Parameters<typeof ai.agentStep>[0]
const saved = { repo: { ...chatRepository }, agentStep: ai.agentStep, get: catalog.get, withDetails: catalog.withDetails, fetch: catalog.fetch }
let seen: Step[] = []
let history: StoredMessage[] = []

before(() => {
  chatRepository.addMessage = async () => 99
  chatRepository.updateMessage = async () => {}
  chatRepository.deleteMessage = async () => {}
  chatRepository.recentMessages = async () => history
  chatRepository.saveSession = async () => {}
  chatRepository.earlierForUser = async () => []
  catalog.get = async () => snapshot
  catalog.withDetails = async (s) => s
  catalog.fetch = async (s, ref) => {
    const l = listings.find((x) => ref.startsWith(x.shortId) || ref === x.id)
    return l ? { snapshot: s, listing: l } : 'unavailable'
  }
  ai.agentStep = (async function* (params: Step) {
    seen.push(params)
    yield { type: 'text' as const, text: 'კარგი.' }
    yield { type: 'done' as const, model: 'stub', parts: [{ text: 'კარგი.' }], calls: [] }
  }) as typeof ai.agentStep
})
after(() => {
  Object.assign(chatRepository, saved.repo)
  Object.assign(catalog, { get: saved.get, withDetails: saved.withDetails, fetch: saved.fetch })
  ai.agentStep = saved.agentStep
})

const msg = (id: number, role: 'user' | 'assistant', content: string): StoredMessage => ({ id, role, content, intent: null, payload: {}, createdAt: '' }) as StoredMessage

async function request(text: string, state: Record<string, unknown>, profile: Session['profile'] = {}) {
  seen = []
  const session: Session = { id: '00000000-0000-4000-8000-0000000000cc', userId: null, title: 't', locale: 'ka', profile, state: sessionStateSchema.parse({ refs: ids, ...state }), turnCount: 4, expiresAt: new Date() }
  await agentTurn({ session, input: { text }, emit: async () => {}, signal: new AbortController().signal })
  const system = seen[0]!.system
  const context = JSON.parse(system.slice(system.indexOf('{', system.indexOf('CONTEXT ('))))
  return { context, contents: seen[0]!.contents }
}

test('CONTEXT has at most five fact sheets — the focus, the listing the message names, those on screen, those just discussed — and no empty fields', async () => {
  history = [msg(1, 'user', 'შეადარე'), msg(2, 'assistant', '**#7 კაფე 7** და **#8 კაფე 8** ძვირია.')]
  const { context } = await request('#2 რა ღირს?', { lastShown: [ids[3], ids[4], ids[5]], contextListingId: ids[3] }, { budgetGel: known(60000), cities: known(['Tbilisi']), involvement: known('part_time'), sectors: known(['restaurants']) })
  assert.deepEqual(context.fact_sheets.map((f: { ref: string }) => f.ref), ['#4', '#2', '#5', '#6', '#7'])
  for (const key of ['missing_key_facts', 'recent_questions', 'already_done', 'earlier_chats', 'changed_by_client']) assert.ok(!(key in context), `${key} is empty: left out`)
})

test('a pasted link reaches the model as the listing\'s number and name, and that listing is the one in focus', async () => {
  history = []
  const target = listings[6]! // not shown before: it gets the next number
  const { context, contents } = await request(`https://mybusiness.ge/ka/listing/${target.shortId} ეს ფასი სამართლიანია?`, { lastShown: [ids[0], ids[1]], contextListingId: ids[0] })
  const text = contents.at(-1)!.parts![0]!.text!
  assert.match(text, /^#7 კაფე, თბილისი ეს ფასი სამართლიანია\?/, text)
  assert.equal(context.listing_in_focus, '#7 კაფე, თბილისი')
  assert.equal(context.fact_sheets[0].ref, '#7', 'its sheet comes first')
})

test('a message that changes the subject drops the old listing from focus, so the next steps follow the new topic', async () => {
  history = []
  const { context } = await request('რესტორანი მინდა 5 000 ლარად', { lastShown: [ids[0]], contextListingId: ids[0] })
  assert.equal(context.listing_in_focus, undefined)
})

test('price comparisons group by what the title says the business is; a vague "other" listing is not compared', () => {
  const state = sessionStateSchema.parse({ refs: ids })
  const cafe = factSheet(cafeAsBakery, snapshot, state, 'ka') as Record<string, string>
  assert.match(cafe.price_vs_similar!, /კაფე \/ რესტორანი/, 'compared with cafés, not bakeries')
  const other = factSheet(vague, snapshot, state, 'ka') as Record<string, string>
  assert.match(other.price_vs_similar!, /ვერ შედარდება/, 'nothing to compare it with fairly: said so, not "82 % cheaper than other"')
})

test('only the latest answer goes to the model at length; older ones keep their opening', async () => {
  const long = (tag: string) => `**${tag}** ${'გრძელი ტექსტი '.repeat(250)}`
  history = [msg(1, 'user', 'ა'), msg(2, 'assistant', long('პირველი')), msg(3, 'user', 'ბ'), msg(4, 'assistant', long('ბოლო'))]
  const { contents } = await request('და?', {})
  const [older, latest] = contents.filter((c) => c.role === 'model').map((c) => c.parts![0]!.text!)
  assert.ok(older!.startsWith('**პირველი**') && older!.length <= 602 && older!.endsWith('…'))
  assert.equal(latest!.length, 2500)
})

test('the briefs: the question decides the answer, an opinion is always given, and nothing is promised that the app cannot do', async () => {
  const { agentSystem } = await import('../src/modules/chat/agent/agent.prompt.js')
  const { voiceSystem } = await import('../src/modules/chat/voice/voice.prompt.js')
  const { toolDeclarations } = await import('../src/modules/chat/agent/agent.tools.js')
  assert.ok(!toolDeclarations.some((t) => /alert/.test(t.name ?? '')), 'there is no alert tool')
  for (const brief of [agentSystem('ka', {}), voiceSystem('ka', {})]) {
    assert.match(brief, /cannot notify or contact anyone/)
    assert.doesNotMatch(brief, /create_alert|alert/i)
    assert.match(brief, /never a reason not to answer/)
  }
  assert.match(agentSystem('ka', {}), /never after a general question, never as a default start/i)
  assert.doesNotMatch(agentSystem('ka', {}), /"OK,/, 'no casual opener to copy')
  assert.match(agentSystem('ka', {}), /ამ ეტაპზე არ გირჩევთ/)
})

test('a rent the business cannot carry is flagged on its fact sheet', () => {
  const costly = make(11, { price: 78000, description: 'მოქმედი ბიზნესი, ქირა 8000 ლარი თვეში' })
  const s = { ...snapshot, listings: [...listings, costly], byId: new Map([...listings, costly].map((l) => [l.id, l])) } as unknown as CatalogSnapshot
  const sheet = factSheet(costly, s, sessionStateSchema.parse({ refs: [costly.id] }), 'ka') as Record<string, string>
  assert.match(sheet.check ?? '', /წლის ქირა ფასზე მეტია/, JSON.stringify(sheet))
  const fine = factSheet(listings[0]!, snapshot, sessionStateSchema.parse({ refs: ids }), 'ka') as Record<string, string>
  assert.doesNotMatch(fine.check ?? '', /ქირა/, 'an ordinary rent is not flagged')
})
