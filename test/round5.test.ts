import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { ai } from '../src/modules/ai/ai.gateway.js'
import { catalog, toListing, type CatalogSnapshot } from '../src/modules/catalog/catalog.service.js'
import { agentTurn } from '../src/modules/chat/agent/agent.service.js'
import { cardFor, factSheet } from '../src/modules/chat/agent/agent.facts.js'
import { yesNoChips } from '../src/modules/chat/agent/agent.next.js'
import { createRepeatCheck, createTextFilter, profileArgsIn, withoutTables } from '../src/modules/chat/agent/agent.text.js'
import { statedBudget } from '../src/modules/chat/agent/agent.tools.js'
import { sessionStateSchema } from '../src/modules/chat/chat.model.js'
import { chatRepository, type Session } from '../src/modules/chat/chat.repository.js'
import { screenMessage } from '../src/modules/chat/guard/guard.service.js'

// Round 5 of manual testing: each bug it found, pinned down. The catalogue is two listings in memory and the model
// is scripted, so no network and no Gemini quota.

const rates = { GEL: 1, USD: 2.6, EUR: 2.9 }
const cafe = toListing({ id: '11111111-0000-4000-8000-000000000001', title: 'იყიდება კაფე ვაკეში', category: 'restaurants', deal_type: 'sale', price: 52000, currency: 'GEL', city: 'Tbilisi', address: 'Zurab Gorgiladze Street 5', description: 'მოქმედი კაფე, ფართი 21 კვ.მ, ქირა 450$ თვეში' }, rates)
const shop = toListing({ id: '22222222-0000-4000-8000-000000000002', title: 'საკონდიტრო ისანში', category: 'bakery', deal_type: 'sale', price: 30000, currency: 'GEL', city: 'Tbilisi', description: 'დღიური ბრუნვა 700-800 ლარი' }, rates)
const listings = [cafe, shop]
const snapshot = { listings, byId: new Map(listings.map((l) => [l.id, l])), byShortId: new Map(listings.map((l) => [l.shortId, l])), stats: new Map(), cities: ['Tbilisi'], categories: ['restaurants', 'bakery'], rates, loadedAt: new Date() } as unknown as CatalogSnapshot

// ── Pure helpers ──

test('markup the model writes is never shown: <form>{…}</form>, fenced JSON, <options>; its facts are kept', () => {
  const f = createTextFilter()
  const chunks = ['ერთი ვარიანტია. <fo', 'rm>{"budget_gel":30000,"cities":["Batumi"]}</form> ', 'და კიდევ ```json\n{"options":["კი","არა"]}\n``` ბოლო < 6 თვე.']
  const shown = chunks.map((c) => f.push(c)).join('')
  const { rest, options, blocks } = f.end()
  const text = shown + rest
  assert.doesNotMatch(text, /form|budget_gel|```|options/)
  assert.match(text, /ერთი ვარიანტია\./)
  assert.match(text, /ბოლო < 6 თვე\./, 'a real "<" stays')
  assert.deepEqual(options, ['კი', 'არა'])
  assert.deepEqual(profileArgsIn(blocks), { budget_gel: 30000, cities: ['Batumi'] })
  assert.equal(withoutTables('ტექსტი\n| შემოსავალი | 20 000 |\n|---|---|\nბოლო'), 'ტექსტი\nბოლო')
})

test("the app's own chips and seller questions are never off-topic; cooking still is", () => {
  assert.equal(screenMessage('მოვამზადოთ კითხვების სია #1-ზე'), null)
  assert.equal(screenMessage('რა ვკითხო გამყიდველს #1-ზე?'), null)
  assert.equal(screenMessage('როგორ მოვამზადო ხაჭაპური?'), 'off_topic')
})

test('a budget stated in a message is read, in GEL', () => {
  assert.equal(statedBudget('რესტორანი მინდა, 50 ათასი მაქვს', rates), 50000)
  assert.equal(statedBudget('რესტორანი მინდა 5 000 ლარად', rates), 5000)
  assert.equal(statedBudget('ბიუჯეტი 100 ათასი დოლარი', rates), 260000)
  assert.equal(statedBudget('#1 ფასი 52 000 ლარი რატომ?', rates), null, 'a listing price is not a budget')
})

test('fact sheets: area read from the text, Georgian names only, over-budget said with the amount, no unfair price comparison', () => {
  const state = sessionStateSchema.parse({})
  const sheet = factSheet(cafe, snapshot, state, 'ka', 50000)
  assert.match(sheet.area, /^21 მ² \*\(გამყიდველის თქმით\)\*$/)
  assert.match(sheet.rent, /\(\$450\) \*\(გამყიდველის თქმით\)\*$/)
  assert.match(sheet.budget!, /2\s000 ₾-ით აღემატება თქვენს ბიუჯეტს \(50\s000 ₾\)/)
  assert.match(sheet.price_vs_similar, /ვერ შედარდება/, 'no listings of its size: no comparison with restaurants in general')
  assert.doesNotMatch(sheet.name, /Gorgiladze/, 'a Latin street never lands in a Georgian name')
  const card = cardFor(cafe, snapshot, state, 'ka', undefined, 50000)
  assert.equal(card.reasons[0]?.code, 'OVER_BUDGET')
  assert.equal(card.area, 21)
})

test('a yes/no closing question gets "yes" and "no" chips', () => {
  assert.deepEqual(yesNoChips('გავაკეთო #1-ის მოგების გათვლა?', 'ka').map((c) => c.label), ['კი, გთხოვთ', 'არა, სხვა რამე მაინტერესებს'])
  assert.deepEqual(yesNoChips('განვახორციელო თუ არა #1-ის მდებარეობის ანალიზი?', 'ka').map((c) => c.label), ['კი, გთხოვთ', 'არა, სხვა რამე მაინტერესებს'])
  assert.equal(yesNoChips('გავაანალიზო #1-ის მდებარეობა?', 'ka').length, 2)
  assert.deepEqual(yesNoChips('ავირჩიოთ #1 თუ #2?', 'ka'), [], 'a choice between two is not yes/no')
  assert.deepEqual(yesNoChips('რომელ უბანში ეძებთ?', 'ka'), [])
})

test('a later step that opens by repeating the line before its tool call drops that line; names are never dropped', () => {
  const said = 'მზად არის შეტყობინება გამყიდველისთვის.'
  const a = createRepeatCheck(said)
  const out = ['შეტყობინება გამყიდველისთვის ', 'მზად არის — შეგიძლიათ', ' გადააკოპიროთ.'].map((c) => a.push(c)).join('') + a.end()
  assert.equal(out, 'შეგიძლიათ გადააკოპიროთ.')
  const b = createRepeatCheck('**#2 რესტორნის ბიზნესი, ნავთლუღის ქუჩა 10** — ვამოწმებ.')
  assert.equal(b.push('**#2 რესტორნის ბიზნესი, ნავთლუღის ქუჩა 10** — დაკეტილია.') + b.end(), '**#2 რესტორნის ბიზნესი, ნავთლუღის ქუჩა 10** — დაკეტილია.')
  const c = createRepeatCheck(said)
  assert.equal(c.push('ქირა დაბალია.') + c.end(), 'ქირა დაბალია.', 'something new stays')
})

// ── The turn, with a scripted model ──

type Step = Parameters<typeof ai.agentStep>[0]
const saved = { repo: { ...chatRepository }, agentStep: ai.agentStep, get: catalog.get, withDetails: catalog.withDetails, fetch: catalog.fetch }
let script: (params: Step) => AsyncGenerator<{ type: 'text'; text: string } | { type: 'done'; model: string; parts: unknown[]; calls: { name: string; args: Record<string, unknown> }[] }>
const seen: Step[] = []

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
  ai.agentStep = ((params: Step) => {
    seen.push(params)
    return script(params)
  }) as typeof ai.agentStep
})
after(() => {
  Object.assign(chatRepository, saved.repo)
  Object.assign(catalog, { get: saved.get, withDetails: saved.withDetails, fetch: saved.fetch })
  ai.agentStep = saved.agentStep
})

const says = (text: string) =>
  async function* () {
    yield { type: 'text' as const, text }
    yield { type: 'done' as const, model: 'stub', parts: [{ text }], calls: [] }
  }

async function run(text: string, state: Partial<ReturnType<typeof sessionStateSchema.parse>> = {}, profile: Session['profile'] = {}) {
  const session: Session = { id: '00000000-0000-4000-8000-000000000005', userId: 'u', title: 't', locale: 'ka', profile, state: sessionStateSchema.parse({ refs: [cafe.id, shop.id], lastShown: [cafe.id, shop.id], ...state, places: { [cafe.id]: { radiusM: 300, direct: 4, within150m: 1, nearest: [], precision: 'street' }, [shop.id]: { radiusM: 300, direct: 2, within150m: 0, nearest: [], precision: 'street' } } }), turnCount: 3, expiresAt: new Date() }
  const events: { event: string; data: unknown }[] = []
  seen.length = 0
  await agentTurn({ session, input: { text }, emit: async (event, data) => void events.push({ event, data }), signal: new AbortController().signal })
  return { events, of: (name: string) => events.filter((e) => e.event === name).map((e) => e.data), tokens: events.filter((e) => e.event === 'token').map((e) => (e.data as { text: string }).text).join('') }
}

test('a seller question always ends with the message card, even when the model only wrote about it', async () => {
  script = says('გაუგზავნეთ გამყიდველს ეს შეტყობინება:')
  const r = await run('რა ვკითხო გამყიდველს #1-ზე?')
  const handoff = r.of('handoff')[0] as { n: number; url: string; text: string } | undefined
  assert.ok(handoff, 'the card is there')
  assert.equal(handoff.n, 1)
  assert.match(handoff.url, /mybusiness\.ge\/ka\/listing\/11111111/)
  assert.ok(handoff.text.length > 20)
})

test('the question the last answer ended with is named next to the message, so it is not asked again', async () => {
  script = says('კარგი.')
  await run('რა ღირს #2?', { askedRecently: ['გსურთ #1-ის მდებარეობის ანალიზი?'] })
  const last = seen[0]!.contents.at(-1)!.parts![0]!.text!
  assert.match(last, /^რა ღირს #2\?/)
  assert.match(last, /already asked "გსურთ #1-ის მდებარეობის ანალიზი\?"/)
})

test("the app's own chip reaches the model even if it looks off-topic", async () => {
  script = says('კარგი.')
  await run('როგორ მოვამზადო ხაჭაპური?', { chipTexts: ['როგორ მოვამზადო ხაჭაპური?'] })
  assert.equal(seen.length, 1, 'not refused by the guard')
})

test('"compare" always gets its table, even when the model compared in words only', async () => {
  script = says('**#2 საკონდიტრო** უკეთესია.')
  const r = await run('შეადარე #1 და #2')
  const table = r.of('compare')[0] as { heads: { n: number }[] } | undefined
  assert.deepEqual(table?.heads.map((h) => h.n), [1, 2])
})

test('a budget in the message is remembered even if the model does not save it; a strip change is spelled out to the model', async () => {
  script = says('კარგი.')
  const r = await run('კაფე მინდა 30 ათასამდე')
  const profile = r.of('profile')[0] as { items: { key: string; value: string }[] }
  assert.ok(profile.items.some((i) => i.key === 'budgetGel' && /30/.test(i.value)))

  await run('მაჩვენე ვარიანტები', { profileEdited: ['budgetGel'] }, { budgetGel: { value: 100000, status: 'known', turn: 3 } })
  const last = seen[0]!.contents.at(-1)!.parts![0]!.text!
  assert.match(last, /memory strip/)
  assert.match(last, /100\s000/)
})

test('markup in the answer is hidden, its form request honoured; chips follow the listing the answer is about', async () => {
  script = says('**#2 საკონდიტრო** ჯობია. <form>{"cities":["Tbilisi"]}</form>გავაკეთო #2-ის მოგების გათვლა?')
  const r = await run('რომელი ჯობია?')
  assert.doesNotMatch(r.tokens, /<form>|cities/)
  const chips = (r.of('quick_replies')[0] as { items: { id: string; label: string }[] }).items
  assert.equal(chips[0]?.label, 'კი, გთხოვთ', 'yes/no answers to the closing question first')
  assert.ok(chips.filter((c) => c.id.startsWith('next:')).every((c) => c.label.startsWith('#2')), 'next steps are about #2, the listing the answer picked')
})
