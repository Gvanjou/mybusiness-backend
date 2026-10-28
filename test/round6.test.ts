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
    // No cost of goods given for a bakery: its usual share is used, and the table says so.
    assert.match(ctx.out.compare!.rows.find((r) => r.key === 'cogs')!.label, /35%, ტიპური/)
  } finally {
    catalog.fetch = saved
  }
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
