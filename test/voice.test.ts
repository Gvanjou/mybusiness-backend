import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { Behavior, type FunctionDeclaration, type LiveConnectConfig } from '@google/genai'
import { catalog, toListing, type CatalogSnapshot } from '../src/modules/catalog/catalog.service.js'
import { ai } from '../src/modules/ai/ai.gateway.js'
import { callTool, CALL_SECONDS, cleanSpeech, saveTurn, startCall } from '../src/modules/chat/voice/voice.live.js'
import { profileItems } from '../src/modules/chat/templates/templates.js'
import { sessionStateSchema } from '../src/modules/chat/chat.model.js'
import { chatRepository, type Session } from '../src/modules/chat/chat.repository.js'
import { gemini } from '../src/pkg/gemini/gemini.js'
import { db } from '../src/pkg/supabase/supabase.js'

// Voice calls: the token the browser gets, the tools it relays, the turns it saves. Google, the catalogue and the
// database are stubbed: no network, no quota.

const rates = { GEL: 1, USD: 2.6, EUR: 2.9 }
const cafe = toListing({ id: '71111111-0000-4000-8000-000000000001', title: 'კაფე ვაკეში', category: 'restaurants', deal_type: 'sale', price: 40000, currency: 'GEL', city: 'Tbilisi', description: 'მოქმედი კაფე' }, rates)
const snapshot = { listings: [cafe], byId: new Map([[cafe.id, cafe]]), byShortId: new Map([[cafe.shortId, cafe]]), stats: new Map(), cities: ['Tbilisi'], categories: ['restaurants'], rates, loadedAt: new Date() } as unknown as CatalogSnapshot

type TokenParams = Parameters<typeof gemini.authTokens.create>[0]
let tokenParams: TokenParams | undefined
const messages: { role: string; content: string; payload?: Record<string, unknown> }[] = []
const sessions: Session[] = []
const keep = { create: gemini.authTokens.create, from: db.from, repo: { ...chatRepository }, get: catalog.get, withDetails: catalog.withDetails, fetch: catalog.fetch, generateJson: ai.generateJson }

before(() => {
  gemini.authTokens.create = (async (p: TokenParams) => {
    tokenParams = p
    return { name: 'auth_tokens/test-token' }
  }) as typeof gemini.authTokens.create
  db.from = (() => ({ insert: () => Promise.resolve({ error: null }) })) as unknown as typeof db.from
  chatRepository.addMessage = async (_s, m) => (messages.push(m), messages.length)
  chatRepository.saveSession = async (s) => void sessions.push(s)
  catalog.get = async () => snapshot
  catalog.withDetails = async (s) => s
  catalog.fetch = async (s) => ({ snapshot: s, listing: cafe })
  ai.generateJson = (async () => ({ summary: 'კლიენტი ეძებს კაფეს თბილისში. ერთი ვარიანტი ნახა.' })) as typeof ai.generateJson
})
after(() => {
  gemini.authTokens.create = keep.create
  db.from = keep.from
  Object.assign(chatRepository, keep.repo)
  Object.assign(catalog, { get: keep.get, withDetails: keep.withDetails, fetch: keep.fetch })
  ai.generateJson = keep.generateJson
})

const session = (state: Record<string, unknown> = {}): Session => ({ id: '00000000-0000-4000-8000-0000000000ee', userId: 'u', title: null, locale: 'ka', profile: {}, state: sessionStateSchema.parse({ refs: [cafe.id], lastShown: [cafe.id], ...state }), turnCount: 2, expiresAt: new Date() })

test('the token is single-use and locks model, voice brief, CONTEXT and the call tools; slow tools do not block speech', async () => {
  const call = await startCall(session(), 'user-a')
  assert.equal(call.token, 'auth_tokens/test-token')
  assert.equal(call.maxSeconds, CALL_SECONDS)
  const cfg = tokenParams!.config!
  assert.equal(cfg.uses, 1)
  assert.equal(cfg.lockAdditionalFields, undefined, 'no lock list: the whole setup is locked')
  const live = cfg.liveConnectConstraints!.config as LiveConnectConfig
  assert.match(String(live.systemInstruction), /voice call/)
  assert.match(String(live.systemInstruction), /"fact_sheets":\[\{"ref":"#1"/, "this chat's fact sheets are in the brief")
  const tools = (live.tools as { functionDeclarations: FunctionDeclaration[] }[])[0]!.functionDeclarations
  assert.deepEqual(tools.map((t) => t.name).sort(), ['compare_listings', 'get_listing', 'location_analysis', 'profit_scenarios', 'search_listings', 'seller_message', 'show_note', 'update_profile'])
  assert.equal(tools.find((t) => t.name === 'search_listings')!.behavior, Behavior.NON_BLOCKING)
  assert.equal(tools.find((t) => t.name === 'seller_message')!.behavior, undefined)
  assert.ok(live.inputAudioTranscription && live.outputAudioTranscription, 'both sides are transcribed for the chat history')
})

test("the call follows the language the client sees, not the chat's stored one: recognition, voice, summary", async () => {
  const s = session() // stored as Georgian
  sessions.length = 0
  await startCall(s, 'user-f', 'ru')
  assert.equal(sessions.at(-1)!.locale, 'ru', 'the chat now speaks the language of the call')
  const live = tokenParams!.config!.liveConnectConstraints!.config as LiveConnectConfig
  assert.deepEqual(live.inputAudioTranscription, { languageCodes: ['ru-RU'] })
  assert.equal(live.speechConfig?.languageCode, 'ru-RU')
  assert.equal(live.realtimeInputConfig?.automaticActivityDetection?.startOfSpeechSensitivity, 'START_SENSITIVITY_LOW')
  messages.length = 0
  await callTool(s, 'get_listing', { ref: '#1' })
  await saveTurn({ ...s, profile: { budgetGel: { value: 30000, status: 'known', turn: 1 } } }, 'кафе', 'Один вариант на экране.', true)
  const payload = messages.at(-1)!.payload as { callSummary: { facts: string[] } }
  assert.match(payload.callSummary.facts[0]!, /^≤ 30\s000 ₾$/, 'facts in the call language (no Georgian label on the budget)')
})

test('each user has a daily allowance of voice minutes; a short call gives back what it did not use', async () => {
  for (let i = 0; i < 6; i++) await startCall(session(), 'user-b') // 6 × 10 of 60 minutes, none ended
  await assert.rejects(startCall(session(), 'user-b'), (err: { code?: string }) => err.code === 'daily_limit')
  // Ended at once, each call books only its seconds: a day of short tries is not a day's minutes.
  for (let i = 0; i < 12; i++) {
    const s = session()
    await startCall(s, 'user-short')
    await saveTurn(s, 'გამარჯობა', 'გამარჯობა.', true)
  }
  await startCall(session(), 'user-short')
})

test("a tool call runs on the chat's own state; only the call's tools run; what they show is saved with the turn", async () => {
  messages.length = 0
  const refused = await callTool(session(), 'create_alert', {})
  assert.match(JSON.stringify(refused.result), /Unknown tool/)

  const note = await callTool(session(), 'show_note', { markdown: '- ქირა\n- <b>ბრუნვა</b>' })
  assert.equal(note.ui.note, '- ქირა\n- ბრუნვა', 'markup removed')
  await callTool(session(), 'seller_message', { ref: '#1', message: 'გამარჯობა! დაინტერესებული ვარ თქვენი კაფით. რა არის რეალური თვიური ბრუნვა?' })
  assert.ok(sessions.length >= 2, 'the state is saved after each tool')

  await saveTurn(session(), 'რა ვკითხო გამყიდველს?', 'შეტყობინება ეკრანზეა.')
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant'])
  const payload = messages[1]!.payload!
  assert.equal(payload.note, '- ქირა\n- ბრუნვა')
  assert.ok(payload.handoff, 'the seller message card')
  assert.equal(payload.voice, true)
  assert.equal(sessions.at(-1)!.title, 'რა ვკითხო გამყიდველს?', 'the chat is titled by its first spoken message')
  assert.equal(sessions.at(-1)!.turnCount, 3)

  messages.length = 0
  await saveTurn(session(), 'კარგი', 'მადლობა.')
  assert.equal(messages[1]!.payload!.note, undefined, 'the next turn starts empty')
})

test('the last exchange of a call is followed by its summary: length, a written summary, the facts, the listings, chips', async () => {
  const s = session()
  await startCall(s, 'user-c')
  const tool = await callTool(s, 'get_listing', { ref: '#1' })
  assert.ok(tool.ui.chips.length > 0 && tool.ui.chips.length <= 2, 'up to two next-step chips with a tool')
  messages.length = 0
  await saveTurn({ ...s, profile: { budgetGel: { value: 40000, status: 'known', turn: 1 } } }, 'კაფე მინდა', 'ერთი ვარიანტი ეკრანზეა.', true, { userSeconds: 5 })
  assert.deepEqual(messages[0]!.payload, { voice: true, voiceSeconds: 5 }, "the client's spoken message carries how long they spoke")
  const summary = messages.at(-1)!
  assert.equal(summary.role, 'assistant')
  const payload = summary.payload as { callSummary: { seconds: number; facts: string[]; summary?: string }; cards: { id: string }[]; quickReplies: unknown[] }
  assert.ok(payload.callSummary.seconds >= 0)
  assert.match(payload.callSummary.summary!, /კლიენტი ეძებს/)
  assert.ok(payload.callSummary.facts.some((f) => /40\s000/.test(f)), 'the budget learned')
  assert.deepEqual(payload.cards.map((c) => c.id), [cafe.id], 'the listing shown during the call')
  assert.ok(payload.quickReplies.length > 0, 'next-step chips under the card')
  // A short call that found nothing leaves no summary, and a call with nothing said none either.
  await startCall(s, 'user-e')
  messages.length = 0
  await saveTurn(s, 'გამარჯობა', 'გამარჯობა.', true)
  assert.equal(messages.length, 2, 'the exchange alone')
  await startCall(s, 'user-e')
  messages.length = 0
  await saveTurn(s, '', '', true)
  assert.equal(messages.length, 0)
})

test('fillers are not part of what the client said; a budget said in dollars stays in dollars on the strip', async () => {
  assert.equal(cleanSpeech('Mhm. სარესტორნო ბიზნესში მაქვს ცოტა გამოცდილება.'), 'სარესტორნო ბიზნესში მაქვს ცოტა გამოცდილება.')
  assert.equal(cleanSpeech('ააა, კაფე მინდა. ეეე თბილისში.'), 'კაფე მინდა. თბილისში.')
  assert.equal(cleanSpeech('ბიუჯეტი 150 000$-მდე მაქვს'), 'ბიუჯეტი 150 000$-მდე მაქვს', 'a sentence with no filler is left alone')
  sessions.length = 0
  await startCall(session(), 'user-d')
  await saveTurn(session(), 'ბიუჯეტი 150 000$-მდე მაქვს', 'კარგი.')
  const profile = sessions.at(-1)!.profile
  assert.deepEqual(profile.budgetOriginal?.value, { amount: 150000, currency: 'USD' })
  const items = profileItems(profile, 'ka')
  assert.match(items.find((i) => i.key === 'budgetGel')!.value, /^≤ \$150\s000 \(≈ 390\s000 ₾\)$/)
  assert.equal(profileItems({ experience: { value: 'some', status: 'known', turn: 1 } }, 'ka').find((i) => i.key === 'experience')!.value, 'გამოცდილება: ცოტა')
})
