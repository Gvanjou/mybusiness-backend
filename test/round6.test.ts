import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { ai } from '../src/modules/ai/ai.gateway.js'
import { catalog, toListing, type CatalogSnapshot } from '../src/modules/catalog/catalog.service.js'
import { fxService } from '../src/modules/fx/fx.service.js'
import { agentTurn } from '../src/modules/chat/agent/agent.service.js'
import { cardFor, factSheet } from '../src/modules/chat/agent/agent.facts.js'
import { formWanted } from '../src/modules/chat/agent/agent.fallback.js'
import { answerChips } from '../src/modules/chat/agent/agent.next.js'
import { fixScript } from '../src/modules/chat/agent/agent.text.js'
import { emptyOutput, runTool, type ToolContext } from '../src/modules/chat/agent/agent.tools.js'
import { sessionStateSchema } from '../src/modules/chat/chat.model.js'
import { chatRepository, type Session } from '../src/modules/chat/chat.repository.js'

// Round 6 of manual testing: each issue it found, pinned down. Listings in memory, the model scripted, the
// National Bank stubbed: no network and no Gemini quota.

const rates = { GEL: 1, USD: 2.6, EUR: 2.9 }
const crowded = toListing({ id: '61111111-0000-4000-8000-000000000001', title: 'კაფე საბურთალოზე', category: 'restaurants', deal_type: 'sale', price: 20000, currency: 'USD', city: 'Tbilisi', employees: 30, description: 'მოქმედი კაფე, ფართი 24 კვ.მ' }, rates)
const other = toListing({ id: '62222222-0000-4000-8000-000000000002', title: 'საცხობი ისანში', category: 'bakery', deal_type: 'sale', price: 30000, currency: 'GEL', city: 'Tbilisi', description: '' }, rates)
const listings = [crowded, other]
const snapshot = { listings, byId: new Map(listings.map((l) => [l.id, l])), byShortId: new Map(listings.map((l) => [l.shortId, l])), stats: new Map(), cities: ['Tbilisi'], categories: ['restaurants', 'bakery'], rates, loadedAt: new Date() } as unknown as CatalogSnapshot
const known = <T>(value: T) => ({ value, status: 'known' as const, turn: 1 })

test('every closing question with obvious answers gets them as buttons: either/or, time, city', () => {
  const labels = (q: string, l: 'ka' | 'en' | 'ru' = 'ka') => answerChips(q, l).map((c) => c.label)
  assert.deepEqual(labels('რომელ ქალაქში ეძებთ, თბილისში თუ ბათუმში?'), ['თბილისში', 'ბათუმში'])
  assert.deepEqual(labels('Вы рассматриваете Тбилиси, Батуми или Кутаиси?', 'ru'), ['Тбилиси', 'Батуми', 'Кутаиси'])
  assert.deepEqual(labels('Сколько времени вы планируете уделять управлению бизнесом?', 'ru'), ['Совсем нет времени', 'Частично', 'Полный день'])
  assert.equal(labels('რომელ ქალაქში ეძებთ ბიზნესს?').length, 3)
  assert.deepEqual(labels('რა მოხდება, თუ ფასი დაიკლებს?'), [], '", თუ" is "if", not a choice')
  assert.deepEqual(labels('გავაკეთო #1-ის მოგების გათვლა?'), ['კი, გთხოვთ', 'არა, სხვა რამე მაინტერესებს'])
})

test('a letter from another alphabet inside a word is replaced by the one it imitates', () => {
  assert.equal(fixScript('პլუსები', 'ka'), 'პლუსები')
  assert.equal(fixScript('Цeна и прoфит, Wolt', 'ru'), 'Цена и профит, Wolt', 'Latin words stay')
  assert.equal(fixScript('plain English', 'en'), 'plain English')
})

test('a seller claim that does not add up is flagged on the fact sheet and the card', () => {
  const state = sessionStateSchema.parse({ refs: [crowded.id] })
  const sheet = factSheet(crowded, snapshot, state, 'ka') as Record<string, string>
  assert.match(sheet.check!, /30 თანამშრომელი 24 მ²-ზე — დაუჯერებლად ბევრია/)
  assert.ok(cardFor(crowded, snapshot, state, 'ka').reasons.some((r) => r.code === 'CHECK_CLAIMS'))
  assert.equal((factSheet(other, snapshot, state, 'ka') as Record<string, string>).check, undefined)
})

const ctxOf = (profile: Session['profile'] = {}): ToolContext => ({ s: snapshot, sessionId: 's', userId: null, turn: 2, locale: 'ka', profile, state: sessionStateSchema.parse({ refs: [crowded.id, other.id] }), out: emptyOutput(), progress: async () => {}, userText: '' })

test('a payback under 6 months is called unusually fast in the profit table itself', async () => {
  const saved = catalog.fetch
  catalog.fetch = async (s) => ({ snapshot: s, listing: other })
  try {
    const ctx = ctxOf()
    await runTool('profit_scenarios', { ref: '#2', revenue_monthly_gel: [6000, 12000, 40000], staff_monthly_gel: 2000 }, ctx)
    const payback = ctx.out.compare!.rows.find((r) => r.key === 'payback')!.values
    assert.match(payback.at(-1)!, /თვე — უჩვეულოდ სწრაფია, გადაამოწმეთ შემოსავალი$/)
    assert.doesNotMatch(payback[0]!, /სწრაფია/)
    // 5.5 months reads "5.5 თვე" and is still under six (it used to round to 6 and pass unflagged).
    const half = ctxOf()
    await runTool('profit_scenarios', { ref: '#2', revenue_monthly_gel: [10000, 20000, 30000], cost_of_goods_pct: 0, staff_monthly_gel: 0, utilities_monthly_gel: 0, other_monthly_gel: 0, tax_pct_of_revenue: 0, price_gel: 55000 }, half)
    // revenue 10 000, no costs: profit 10 000 → price 55 000 / 10 000 = 5.5
    const row = half.out.compare!.rows.find((r) => r.key === 'payback')!
    assert.match(row.values[0]!, /^5,5 თვე — უჩვეულოდ/, 'a decimal comma in Georgian')
    // No cost of goods given for a bakery: its usual share is used, and the table says so.
    assert.match(ctx.out.compare!.rows.find((r) => r.key === 'cogs')!.label, /35%, ტიპური/)
    // Production test, 29 Oct: the whole cost template, every line in every table, whatever the model passed.
    const keys = ctx.out.compare!.rows.map((r) => r.key)
    for (const key of ['revenue', 'cogs', 'rent', 'staff', 'owner_salary', 'utilities', 'other', 'tax', 'profit', 'payback']) assert.ok(keys.includes(key), key)
    assert.match(ctx.out.compare!.rows.find((r) => r.key === 'rent')!.label, /არ არის მითითებული/)
    // A buyer who wants passive income pays a manager.
    const passive = ctxOf({ goal: known('passive_income') })
    await runTool('profit_scenarios', { ref: '#2', revenue_monthly_gel: [6000, 12000, 40000] }, passive)
    const manager = passive.out.compare!.rows.find((r) => r.key === 'owner_salary')!
    assert.match(manager.label, /მენეჯერის ხელფასი \(ტიპური\)/)
    assert.equal(manager.values[0], '−2 000 ₾'.replace(' ', '\u00a0'))
  } finally {
    catalog.fetch = saved
  }
})

test('a dollar listing shows its dollar price first; converted lari are rounded, so a new rate does not show', () => {
  for (const usd of [2.6, 2.596, 2.5957]) {
    const l = toListing({ id: '63333333-0000-4000-8000-000000000003', title: 'კაფე', category: 'restaurants', deal_type: 'sale', price: 20000, currency: 'USD', city: 'Tbilisi', description: 'ქირა 450$ თვეში, კვირაში 7 000 ლარის ბრუნვა' }, { ...rates, USD: usd })
    const s = { ...snapshot, rates: { ...rates, USD: usd } } as unknown as CatalogSnapshot
    const sheet = factSheet(l, s, sessionStateSchema.parse({ refs: [l.id] }), 'ka') as Record<string, string>
    assert.match(sheet.price!, /^\$20\s000 \(≈ 52\s000 ₾\)$/, `at ${usd}`)
    assert.match(sheet.rent!, /^≈ 1\s200 ₾\/თვე \(\$450\)/, `at ${usd}`)
    assert.match(sheet.turnover!, /^≈ 30\s000 ₾\/თვე \(7\s000 ₾ კვირაში\)/, 'a weekly figure as months, rounded')
    const card = cardFor(l, s, sessionStateSchema.parse({ refs: [l.id] }), 'ka')
    assert.deepEqual([card.priceGel, card.priceUsd], [52000, 20000], 'the card: its own dollars exact, the lari rounded')
  }
})

test('a score an answer gave is kept on the fact sheet, so the next answer repeats it', async () => {
  const saved = ai.agentStep
  const text = '### #1 კაფე\n- **შეფასება:** 3/10\n### #2 საცხობი\n- **შეფასება:** 7,5/10\n\n**#2** ჯობია.'
  ai.agentStep = (async function* () {
    yield { type: 'text' as const, text }
    yield { type: 'done' as const, model: 'stub', parts: [{ text }], calls: [] }
  }) as typeof ai.agentStep
  const sessions: Session[] = []
  chatRepository.saveSession = async (s) => void sessions.push(s)
  try {
    const session: Session = { id: '00000000-0000-4000-8000-000000000016', userId: 'u', title: 't', locale: 'ka', profile: {}, state: sessionStateSchema.parse({ refs: [crowded.id, other.id], lastShown: [crowded.id, other.id], cardsShown: [crowded.id, other.id] }), turnCount: 3, expiresAt: new Date() }
    await agentTurn({ session, input: { text: 'რომელი ჯობია?' }, emit: async () => {}, signal: new AbortController().signal })
    const state = sessions.at(-1)!.state
    assert.deepEqual(state.scores, { [crowded.id]: '3/10', [other.id]: '7.5/10' })
    assert.equal((factSheet(other, snapshot, state, 'ka') as Record<string, string>).score, '7.5/10')
  } finally {
    ai.agentStep = saved
    chatRepository.saveSession = async () => {}
  }
})

test('a listing filed as "other" is named by what its text says it is, not "სხვა"', () => {
  const state = sessionStateSchema.parse({})
  const vague = toListing({ id: '64444444-0000-4000-8000-000000000004', title: 'იყიდება ბიზნესი ვაკეში', category: 'other', deal_type: 'sale', price: 30000, currency: 'GEL', city: 'Tbilisi', description: 'მოქმედი სილამაზის სალონი, 40 კვ.მ' }, rates)
  assert.doesNotMatch(cardFor(vague, snapshot, state, 'ka').name, /^სხვა/)
  const named = toListing({ id: '65555555-0000-4000-8000-000000000005', title: 'იყიდება ბიზნესი', category: 'other', deal_type: 'sale', price: 30000, currency: 'GEL', city: 'Tbilisi', description: 'კარგი ადგილი' }, rates)
  assert.match(cardFor(named, snapshot, state, 'ka').name, /^სხვა/, 'nothing better to say: the category stays')
})

test("the seller message never carries the chat's own numbers", async () => {
  const ctx = ctxOf()
  await runTool('seller_message', { ref: '#2', message: 'გამარჯობა! დაინტერესებული ვარ #2 საცხობის ბიზნესით. რა არის #2-ის რეალური თვიური ბრუნვა?' }, ctx)
  assert.equal(ctx.out.handoff!.text, 'გამარჯობა! დაინტერესებული ვარ საცხობის ბიზნესით. რა არის რეალური თვიური ბრუნვა?')
})

test('type and budget named: listings at once, no form; a vaguer start still gets the form', () => {
  assert.equal(formWanted({ sectors: known(['restaurants']), budgetGel: known(50000) }), false)
  assert.equal(formWanted({ budgetGel: known(50000) }), true, 'only a budget')
  assert.equal(formWanted({}), true)
})

test('when the National Bank answers no dated query, its latest rates are used, not the fallback', async () => {
  const saved = globalThis.fetch
  const asked: string[] = []
  globalThis.fetch = (async (url: string) => {
    asked.push(url)
    const body = url.includes('date=') ? [] : [{ date: '2026-10-29T00:00:00.000Z', currencies: [{ code: 'USD', quantity: 1, rate: 2.5957 }, { code: 'EUR', quantity: 1, rate: 2.8875 }] }]
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  try {
    assert.equal((await fxService.latest()).USD, 2.5957)
    assert.ok(!asked[0]!.includes('date='), 'the latest rates are asked first')
  } finally {
    globalThis.fetch = saved
  }
})

// ── The turn, with a scripted model ──

type Step = Parameters<typeof ai.agentStep>[0]
const keep = { repo: { ...chatRepository }, agentStep: ai.agentStep, get: catalog.get, withDetails: catalog.withDetails, fetch: catalog.fetch }

before(() => {
  chatRepository.addMessage = async () => 1
  chatRepository.updateMessage = async () => {}
  chatRepository.deleteMessage = async () => {}
  chatRepository.recentMessages = async () => []
  chatRepository.saveSession = async () => {}
  chatRepository.earlierForUser = async () => []
  catalog.get = async () => snapshot
  catalog.withDetails = async (s) => s
  catalog.fetch = async (s, ref) => {
    const l = listings.find((x) => ref.startsWith(x.shortId) || ref === x.id)
    return l ? { snapshot: s, listing: l } : 'unavailable'
  }
  ai.agentStep = (async function* (_: Step) {
    yield { type: 'text' as const, text: '**#2 საცხობი** უკეთესია.' }
    yield { type: 'done' as const, model: 'stub', parts: [{ text: '**#2 საცხობი** უკეთესია.' }], calls: [] }
  }) as typeof ai.agentStep
})
after(() => {
  Object.assign(chatRepository, keep.repo)
  Object.assign(catalog, { get: keep.get, withDetails: keep.withDetails, fetch: keep.fetch })
  ai.agentStep = keep.agentStep
})

test('a listing compared for the first time gets its card next to the table; one already shown does not', async () => {
  const session: Session = { id: '00000000-0000-4000-8000-000000000006', userId: 'u', title: 't', locale: 'ka', profile: {}, state: sessionStateSchema.parse({ refs: [crowded.id, other.id], lastShown: [crowded.id], cardsShown: [crowded.id] }), turnCount: 3, expiresAt: new Date() }
  const events: { event: string; data: unknown }[] = []
  await agentTurn({ session, input: { text: 'შეადარე #1 და #2' }, emit: async (event, data) => void events.push({ event, data }), signal: new AbortController().signal })
  const cards = events.filter((e) => e.event === 'listings').flatMap((e) => (e.data as { cards: { id: string }[] }).cards.map((c) => c.id))
  assert.ok(events.some((e) => e.event === 'compare'), `the table (${events.map((e) => e.event).join(',')})`)
  assert.deepEqual(cards, [other.id], 'a card only for the new one')
})
