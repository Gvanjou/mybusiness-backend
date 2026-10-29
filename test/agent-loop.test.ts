import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { ai, AiUnavailableError } from '../src/modules/ai/ai.gateway.js'
import { agentTurn } from '../src/modules/chat/agent/agent.service.js'
import type { AppError } from '../src/shared/http/app-error.js'
import { chatRepository, type Session } from '../src/modules/chat/chat.repository.js'
import { sessionStateSchema } from '../src/modules/chat/chat.model.js'

// The agent loop with a scripted model: tool calls are executed, their results go back to the model,
// the UI events go out in the right order, and the user is told to retry when no model is available.
// No Gemini quota is spent and nothing is written to the database (the conversation store is in memory).

type Step = Parameters<typeof ai.agentStep>[0]
const original = ai.agentStep
let script: ((params: Step, n: number) => AsyncGenerator<{ type: 'text'; text: string } | { type: 'done'; model: string; parts: unknown[]; calls: { name: string; args: Record<string, unknown> }[] }>) | null = null
let calls = 0

const saved = { ...chatRepository }
const stored: { role: string; content: string; payload?: Record<string, unknown> }[] = []
let earlier: Awaited<ReturnType<typeof chatRepository.earlierForUser>> = []

before(() => {
  chatRepository.addMessage = async (_id, m) => stored.push({ ...m })
  chatRepository.updateMessage = async (_id, id, m) => {
    const x = stored[id - 1]
    if (!x) return
    if (m.content !== undefined) x.content = m.content
    if (m.payload !== undefined) x.payload = m.payload
  }
  chatRepository.deleteMessage = async () => {}
  chatRepository.recentMessages = async () => []
  chatRepository.saveSession = async () => {}
  chatRepository.earlierForUser = async () => earlier
  ai.agentStep = ((params: Step) => {
    if (!script) throw new AiUnavailableError('responder')
    return script(params, ++calls)
  }) as typeof ai.agentStep
})
after(() => {
  Object.assign(chatRepository, saved)
  ai.agentStep = original
})

async function run(text: string, model?: string, opts: { profile?: Session['profile']; signal?: AbortSignal; input?: Parameters<typeof agentTurn>[0]['input'] } = {}) {
  const session: Session = { id: '00000000-0000-4000-8000-000000000001', userId: 'test-user', title: null, locale: 'ka', profile: opts.profile ?? {}, state: sessionStateSchema.parse({}), turnCount: 0, expiresAt: new Date() }
  const events: { event: string; data: unknown }[] = []
  calls = 0
  await agentTurn({ session, input: opts.input ?? { text, model }, emit: async (event, data) => void events.push({ event, data }), signal: opts.signal ?? new AbortController().signal })
  const tokens = events.filter((e) => e.event === 'token').map((e) => (e.data as { text: string }).text).join('')
  return { events, tokens, of: (name: string) => events.filter((e) => e.event === name).map((e) => e.data) }
}

test('a reply that shows the form ends there, even when the same step saved a fact: one introduction, not two', async () => {
  script = async function* (_params, n) {
    if (n === 1) {
      yield { type: 'text', text: 'ჯერ რამდენიმე კითხვა.' }
      const c1 = { name: 'update_profile', args: { budget_gel: 50000, involvement: 'part_time' } }
      const c2 = { name: 'show_form', args: {} }
      yield { type: 'done', model: 'stub', parts: [{ text: 'ჯერ რამდენიმე კითხვა.' }, { functionCall: c1 }, { functionCall: c2 }], calls: [c1, c2] }
      return
    }
    yield { type: 'text', text: 'გთხოვთ, მიუთითოთ რა ტიპის ბიზნესი გაინტერესებთ.' }
    yield { type: 'done', model: 'stub', parts: [{ text: 'გთხოვთ, მიუთითოთ რა ტიპის ბიზნესი გაინტერესებთ.' }], calls: [] }
  }
  const r = await run('მინდა ბიზნესის ყიდვა, არ ვიცი რომელი')
  assert.equal(calls, 1, 'no second step: it would only introduce the same form again')
  assert.equal(r.tokens, 'ჯერ რამდენიმე კითხვა.')
  const form = r.of('form')[0] as { questions: { field: string; selected?: string }[]; submitLabel: string }
  assert.deepEqual(form.questions.map((q) => q.field), ['budget', 'goal', 'involvement', 'location', 'sector'], 'always the standard form')
  assert.deepEqual(form.questions.map((q) => q.selected), ['80000', undefined, 'part_time', undefined, undefined], 'what the client said is pre-selected')
  const profile = r.of('profile')[0] as { items: { key: string; value: string }[] }
  assert.ok(profile.items.some((i) => i.key === 'budgetGel' && i.value.includes('50')), 'update_profile applied the budget')
  assert.ok(profile.items.some((i) => i.key === 'involvement'))
  assert.equal(r.events.at(-1)?.event, 'done')
})

test('tool calls run, and their results reach the next step', async () => {
  const seen: Step[] = []
  script = async function* (params, n) {
    seen.push(params)
    if (n === 1) {
      yield { type: 'text', text: 'ბიუჯეტს დავიმახსოვრებ.' }
      const c1 = { name: 'update_profile', args: { budget_gel: 50000, involvement: 'part_time' } }
      yield { type: 'done', model: 'stub', parts: [{ text: 'ბიუჯეტს დავიმახსოვრებ.' }, { functionCall: c1 }], calls: [c1] }
      return
    }
    yield { type: 'text', text: 'რა ტიპის ბიზნესი გაინტერესებთ?' }
    yield { type: 'done', model: 'stub', parts: [{ text: 'რა ტიპის ბიზნესი გაინტერესებთ?' }], calls: [] }
  }
  await run('50 ათასი მაქვს, ნახევარ განაკვეთზე ვიმუშავებ')
  assert.equal(calls, 2, 'a step with a non-terminal tool continues; the text-only step ends it')
  // The second step received the model's own parts and one function response per call, in order.
  const step2 = seen[1]!.contents
  assert.equal(step2.at(-2)!.role, 'model')
  assert.equal(step2.at(-1)!.role, 'user')
  assert.deepEqual((step2.at(-1)!.parts ?? []).map((p) => p.functionResponse?.name), ['update_profile'])
  assert.equal(seen[1]!.tools.length > 0, true, 'tools are still offered on the second step')
})

test('out of time after the tools ran: one last short step writes the answer instead of "try again"', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() })
  try {
    const seen: Step[] = []
    script = async function* (params, n) {
      seen.push(params)
      if (n === 1) {
        const c = { name: 'update_profile', args: { budget_gel: 50000 } }
        mock.timers.tick(60_000) // the first step and its tools used the whole budget
        yield { type: 'done', model: 'stub', parts: [{ functionCall: c }], calls: [c] }
        return
      }
      yield { type: 'text', text: 'ბიუჯეტი 50 000 ₾-ია.' }
      yield { type: 'done', model: 'stub', parts: [{ text: 'ბიუჯეტი 50 000 ₾-ია.' }], calls: [] }
    }
    const r = await run('50 ათასი მაქვს')
    assert.equal(calls, 2)
    assert.equal(r.tokens, 'ბიუჯეტი 50 000 ₾-ია.')
    assert.equal(seen[1]!.tools.length, 0, 'the last step only writes')
    assert.equal(r.of('error').length, 0)
  } finally {
    mock.timers.reset()
  }
})

test('a kind of business and a city named in a statement are remembered even when the model saves neither', async () => {
  script = async function* () {
    yield { type: 'text', text: 'ბათუმში კაფეებს გაჩვენებთ.' }
    yield { type: 'done', model: 'stub', parts: [{ text: 'ბათუმში კაფეებს გაჩვენებთ.' }], calls: [] }
  }
  const keys = async (text: string) => ((await run(text)).of('profile')[0] as { items: { key: string }[] }).items.map((i) => i.key)
  const said = await keys('კაფე მინდა ბათუმში, 200 ათასამდე')
  assert.ok(said.includes('sectors') && said.includes('cities') && said.includes('budgetGel'), said.join())
  const asked = await keys('რა ღირს კაფე თბილისში?')
  assert.ok(!asked.includes('sectors') && !asked.includes('cities'), 'a question only mentions them')
})

test('chips with text end the turn after one step', async () => {
  script = async function* () {
    yield { type: 'text', text: 'რით დავიწყოთ?' }
    const c = { name: 'suggest_replies', args: { options: ['ბიუჯეტი მაქვს', 'ჯერ ვიკითხავ'] } }
    yield { type: 'done', model: 'stub', parts: [{ text: 'რით დავიწყოთ?' }, { functionCall: c }], calls: [c] }
  }
  const r = await run('გამარჯობა, ბიზნესი მაინტერესებს')
  assert.equal(calls, 1)
  assert.deepEqual((r.of('quick_replies')[0] as { items: { label: string }[] }).items.map((i) => i.label), ['ბიუჯეტი მაქვს', 'ჯერ ვიკითხავ'])
})

test('chips called before any text: the model gets the result and writes its reply in the next step', async () => {
  script = async function* (_params, n) {
    if (n === 1) {
      const c = { name: 'suggest_replies', args: { options: ['კი', 'არა'] } }
      yield { type: 'done', model: 'stub', parts: [{ functionCall: c }], calls: [c] }
      return
    }
    yield { type: 'text', text: 'პასუხი ტექსტით.' }
    yield { type: 'done', model: 'stub', parts: [{ text: 'პასუხი ტექსტით.' }], calls: [] }
  }
  const r = await run('რამე')
  assert.equal(calls, 2)
  assert.equal(r.tokens, 'პასუხი ტექსტით.')
  assert.equal((r.of('quick_replies')[0] as { items: unknown[] }).items.length, 2)
})

test('a form with no words still gets an intro line, so the history has no empty answer', async () => {
  script = async function* () {
    const c = { name: 'show_form', args: {} }
    yield { type: 'done', model: 'stub', parts: [{ functionCall: c }], calls: [c] }
  }
  const r = await run('დამეხმარე არჩევაში')
  assert.ok(r.tokens.length > 10, 'some text goes out')
  assert.equal(r.of('form').length, 1)
})

test('a business type named in the message is enough to search on: the form is refused and the model is told to search', async () => {
  script = async function* (_params, n) {
    if (n === 1) {
      const c = { name: 'show_form', args: {} }
      yield { type: 'done', model: 'stub', parts: [{ functionCall: c }], calls: [c] }
      return
    }
    yield { type: 'text', text: 'რა ბიუჯეტი გაქვთ?' }
    yield { type: 'done', model: 'stub', parts: [{ text: 'რა ბიუჯეტი გაქვთ?' }], calls: [] }
  }
  const r = await run('რესტორანი მინდა ვიყიდო, დამეხმარეთ')
  assert.equal(calls, 2, 'the refusal goes back to the model')
  assert.equal(r.of('form').length, 0)
})

test('the last step offers only chips, so a model that keeps calling tools still produces an answer', async () => {
  script = async function* (params, n) {
    if (params.tools.every((t) => t.name === 'suggest_replies')) {
      yield { type: 'text', text: 'საბოლოო პასუხი.' }
      yield { type: 'done', model: 'stub', parts: [{ text: 'საბოლოო პასუხი.' }], calls: [] }
      return
    }
    const c = { name: 'calculate', args: { price_gel: 40000, profit_monthly_gel: 2500 } }
    yield { type: 'done', model: 'stub', parts: [{ functionCall: c }], calls: [c] }
    void n
  }
  const r = await run('გამოთვალე')
  assert.equal(calls, 3)
  assert.equal(r.tokens, 'საბოლოო პასუხი.')
})

test('no model available: no answer without AI, the user gets a retryable error', async () => {
  script = null
  await assert.rejects(run('რა არის due diligence?'), (err: AppError) => err.code === 'ai_unavailable')
})

test('a reply that announces a search without doing it continues until the search is done', async () => {
  const seen: Step[] = []
  script = async function* (params, n) {
    seen.push(params)
    if (n === 1) {
      const text = 'პასიური შემოსავლისთვის ნაწილობრივი ჩართულობით კარგია მოქმედი გუნდის მქონე ბიზნესი. მოდით, ვნახოთ, რა ვარიანტებია ახლა თბილისში.'
      yield { type: 'text', text }
      yield { type: 'done', model: 'stub', parts: [{ text }], calls: [] }
      return
    }
    if (n === 2) {
      const c = { name: 'calculate', args: { price_gel: 40000, profit_monthly_gel: 2500 } }
      yield { type: 'done', model: 'stub', parts: [{ functionCall: c }], calls: [c] }
      return
    }
    yield { type: 'text', text: 'აი, რა ვიპოვე.' }
    yield { type: 'done', model: 'stub', parts: [{ text: 'აი, რა ვიპოვე.' }], calls: [] }
  }
  const r = await run('პასიური შემოსავალი, ნაწილობრივ, თბილისი')
  assert.equal(calls, 3, 'the announced search is carried out instead of ending the reply')
  const texts = seen[1]!.contents.flatMap((c) => (c.parts ?? []).map((p) => p.text ?? ''))
  assert.ok(texts.some((t) => /Do it now/.test(t)), 'the model is told to carry out what it announced')
  assert.match(r.tokens, /მოდით, ვნახოთ[\s\S]*აი, რა ვიპოვე\./)
})

test('a reply that ends with a real question is not treated as an unfinished action', async () => {
  const { announcesAction } = await import('../src/modules/chat/agent/agent.service.js')
  assert.equal(announcesAction('გინდათ, ვნახოთ ვარიანტები?'), false)
  assert.equal(announcesAction('Let me check what is on the site.'), true)
  assert.equal(announcesAction('Давайте посмотрим варианты.'), true)
  assert.equal(announcesAction('აი სამი ვარიანტი თქვენთვის.'), false)
})

test('the form is refused when only one key fact is missing: the model asks that one thing in text', async () => {
  script = async function* (_params, n) {
    if (n === 1) {
      const c = { name: 'show_form', args: {} }
      yield { type: 'done', model: 'stub', parts: [{ functionCall: c }], calls: [c] }
      return
    }
    yield { type: 'text', text: 'რა ტიპის ბიზნესი გაინტერესებთ?' }
    yield { type: 'done', model: 'stub', parts: [{ text: 'რა ტიპის ბიზნესი გაინტერესებთ?' }], calls: [] }
  }
  const known = <T>(value: T) => ({ value, status: 'known' as const, turn: 1 })
  const r = await run('დამეხმარეთ', undefined, { profile: { budgetGel: known(50000), involvement: known('part_time' as const), cities: known(['Tbilisi']) } })
  assert.equal(calls, 2, 'the refusal goes back to the model')
  assert.equal(r.of('form').length, 0)
  assert.equal(r.tokens, 'რა ტიპის ბიზნესი გაინტერესებთ?')
})

test('an answer cut at the length limit is carried on; cut too often, it is saved as unfinished', async () => {
  stored.length = 0
  script = async function* (_params, n) {
    yield { type: 'text', text: `ნაწილი ${n} ` }
    yield { type: 'done', model: 'stub', parts: [{ text: `ნაწილი ${n} ` }], calls: [], cut: 'length' } as never
  }
  const r = await run('შეადარე ყველა')
  assert.equal(calls, 3, 'two continuations, then it stops')
  assert.equal(r.tokens, 'ნაწილი 1 ნაწილი 2 ნაწილი 3 ', 'continuations join the same sentence')
  assert.equal((r.of('done')[0] as { incomplete?: boolean }).incomplete, true)
  const answer = stored.at(-1)!
  assert.equal(answer.role, 'assistant')
  assert.equal(answer.payload?.incomplete, true, 'saved as unfinished, so the client can continue it')
  assert.equal(stored[0]!.role, 'user', 'the client’s message was saved first')
})

test('a stream that went quiet is continued instead of being saved as a finished answer', async () => {
  script = async function* (params, n) {
    if (n === 1) {
      yield { type: 'text', text: 'პირველი ნახევარი, ' }
      yield { type: 'done', model: 'stub', parts: [{ text: 'პირველი ნახევარი, ' }], calls: [], cut: 'stalled' } as never
      return
    }
    assert.match(String(params.contents.at(-1)?.parts?.[0]?.text), /cut off/)
    yield { type: 'text', text: 'მეორე ნახევარი.' }
    yield { type: 'done', model: 'stub', parts: [{ text: 'მეორე ნახევარი.' }], calls: [] }
  }
  const r = await run('რისკები?')
  assert.equal(r.tokens, 'პირველი ნახევარი, მეორე ნახევარი.')
  assert.equal((r.of('done')[0] as { incomplete?: boolean }).incomplete, undefined)
})

test('the client leaves mid-answer: what was written is kept as unfinished, nothing more is sent', async () => {
  stored.length = 0
  const leave = new AbortController()
  script = async function* () {
    yield { type: 'text', text: 'ნახევრად დაწერილი' }
    leave.abort()
    yield { type: 'done', model: 'stub', parts: [{ text: 'ნახევრად დაწერილი' }], calls: [] }
  }
  const r = await run('რა ღირს?', undefined, { signal: leave.signal })
  assert.equal(r.of('done').length, 0)
  assert.deepEqual([stored.at(-1)?.role, stored.at(-1)?.content, stored.at(-1)?.payload?.incomplete], ['assistant', 'ნახევრად დაწერილი', true])
})

test('continue: the unfinished answer is carried on in the same message', async () => {
  stored.length = 0
  stored.push({ role: 'user', content: 'შეადარე' }, { role: 'assistant', content: 'პირველი ვარიანტი უკეთესია, რად', payload: { incomplete: true, cards: [] } })
  const recent = chatRepository.recentMessages
  chatRepository.recentMessages = async () => stored.map((m, i) => ({ id: i + 1, role: m.role as 'user' | 'assistant', content: m.content, intent: 'chat', payload: m.payload ?? {}, createdAt: '' }))
  try {
    let seen: Step | undefined
    script = async function* (params) {
      seen = params
      yield { type: 'text', text: 'გან ქირა დაბალია.' }
      yield { type: 'done', model: 'stub', parts: [{ text: 'გან ქირა დაბალია.' }], calls: [] }
    }
    const r = await run('', undefined, { input: { action: 'continue' } })
    assert.equal(seen?.contents.at(-2)?.parts?.[0]?.text, 'პირველი ვარიანტი უკეთესია, რად', 'the model sees exactly where it stopped')
    assert.equal(r.tokens, 'გან ქირა დაბალია.')
    assert.deepEqual(r.of('done')[0], { messageId: 2, model: 'stub', incomplete: undefined, continued: true })
    assert.equal(stored[1]!.content, 'პირველი ვარიანტი უკეთესია, რადგან ქირა დაბალია.')
    assert.equal(stored[1]!.payload?.incomplete, undefined)
    assert.equal(stored.length, 2, 'no new message')
  } finally {
    chatRepository.recentMessages = recent
  }
})

test('the screenshot case: "შეავსოთ მოკლე კითხვარი" with no form at all → the app shows the form itself', async () => {
  script = async function* () {
    const text = 'საუკეთესო მიდგომაა. იმისათვის, რომ შევძლოთ თქვენთვის ყველაზე შესაფერისი ბიზნესების შერჩევა, გთხოვთ შეავსოთ მოკლე კითხვარი:'
    yield { type: 'text', text }
    yield { type: 'done', model: 'stub', parts: [{ text }], calls: [] }
  }
  const r = await run('ზუსტად არა რა ტიპებია მომე და ავირჩევ')
  const form = r.of('form')[0] as { questions: { field: string; options: unknown[] }[] } | undefined
  assert.ok(form, 'a form is on screen')
  assert.deepEqual(form.questions.map((q) => q.field).slice(0, 3), ['budget', 'goal', 'involvement'])
  assert.ok(form.questions.every((q) => q.options.length >= 2))
  assert.equal(r.events.at(-1)?.event, 'done')
})

test('"let\'s see the options" with no search → the app searches and shows listings', async () => {
  script = async function* () {
    const text = 'კარგი, მოდით, ვნახოთ, რა ვარიანტებია თბილისში.'
    yield { type: 'text', text }
    yield { type: 'done', model: 'stub', parts: [{ text }], calls: [] }
  }
  const r = await run('მაჩვენე')
  assert.ok(r.of('listings').length === 1, 'listing cards are on screen')
})

test('a picked model is the only one tried, and the answer says which model wrote it', async () => {
  const seen: Step[] = []
  script = async function* (params) {
    seen.push(params)
    yield { type: 'text', text: 'პასუხი.' }
    yield { type: 'done', model: 'gemini-3.5-flash-lite', parts: [{ text: 'პასუხი.' }], calls: [] }
  }
  const r = await run('რა არის due diligence?', 'gemini-3.5-flash-lite')
  assert.equal(seen[0]!.only, 'gemini-3.5-flash-lite')
  assert.equal((r.of('done')[0] as { model?: string }).model, 'Gemini 3.5 Flash-Lite')
})

test('a picked model that is busy is reported with its reason instead of quietly switching', async () => {
  script = null // the model does not answer
  await assert.rejects(run('რა არის due diligence?', 'gemini-3.8-flash'), (err: AppError) => err.code === 'model_unavailable' && err.details?.model === 'gemini-3.8-flash' && err.details?.reason === 'busy')
})

test('a picked model already used up today is refused at once, without calling it', async () => {
  const { quota } = await import('../src/modules/ai/ai.quota.js')
  quota.markExhausted('gemini-3.7-flash')
  let called = false
  script = async function* () {
    called = true
    yield { type: 'done', model: 'x', parts: [], calls: [] }
  }
  await assert.rejects(run('გამარჯობა', 'gemini-3.7-flash'), (err: AppError) => err.code === 'model_unavailable' && err.details?.reason === 'limit')
  assert.equal(called, false)
})

test('a turn that fails keeps the message as unanswered; the retry replaces it instead of adding it twice', async () => {
  stored.length = 0
  script = null // no model answers
  await assert.rejects(run('კომერციულ ფართს ვეძებ ვაკეში'))
  const failed = stored.at(-1)!
  assert.deepEqual([failed.role, failed.content, failed.payload?.failed], ['user', 'კომერციულ ფართს ვეძებ ვაკეში', true], 'saved first, then marked unanswered')

  const deleted: number[] = []
  const recent = chatRepository.recentMessages
  const del = chatRepository.deleteMessage
  chatRepository.recentMessages = async () => [{ id: 41, role: 'user', content: 'კომერციულ ფართს ვეძებ ვაკეში', intent: 'failed', payload: { failed: true }, createdAt: '' }]
  chatRepository.deleteMessage = async (_s, id) => void deleted.push(id)
  try {
    script = async function* () {
      yield { type: 'text', text: 'რისთვის გჭირდებათ ფართი?' }
      yield { type: 'done', model: 'stub', parts: [{ text: 'რისთვის გჭირდებათ ფართი?' }], calls: [] }
    }
    await run('კომერციულ ფართს ვეძებ ვაკეში')
    assert.deepEqual(deleted, [41])
  } finally {
    chatRepository.recentMessages = recent
    chatRepository.deleteMessage = del
  }
})

test('earlier chats: only counted in the context; recalled on demand, nothing applied without the client', async () => {
  earlier = [
    {
      id: '00000000-0000-4000-8000-000000000009',
      title: 'კაფე თბილისში',
      updatedAt: '2026-10-27T10:00:00Z',
      profile: { budgetGel: { value: 50000, status: 'known', turn: 1 }, cities: { value: ['Tbilisi'], status: 'known', turn: 1 } },
      state: sessionStateSchema.parse({}),
    },
  ]
  const seen: Step[] = []
  script = async function* (params, n) {
    seen.push(params)
    if (n === 1) {
      const c = { name: 'recall_previous_chats', args: {} }
      yield { type: 'done', model: 'stub', parts: [{ functionCall: c }], calls: [c] }
      return
    }
    yield { type: 'text', text: 'წინა საუბარში ბიუჯეტი 50 000 ₾ იყო — ისევ ეს გამოვიყენო?' }
    yield { type: 'done', model: 'stub', parts: [{ text: 'წინა საუბარში ბიუჯეტი 50 000 ₾ იყო — ისევ ეს გამოვიყენო?' }], calls: [] }
  }
  const r = await run('რა ბიუჯეტი გითხარი?')
  earlier = []
  assert.match(seen[0]!.system, /"earlier_chats":1/, 'the model knows there is an earlier chat')
  assert.doesNotMatch(seen[0]!.system, /50000/, 'but not what was in it until it asks')
  const recalled = seen[1]!.contents.flatMap((c) => c.parts ?? []).find((p) => p.functionResponse?.name === 'recall_previous_chats')!.functionResponse!.response!.result as { chats: { title: string; facts: Record<string, unknown> }[] }
  assert.equal(recalled.chats[0]!.title, 'კაფე თბილისში')
  assert.equal(recalled.chats[0]!.facts.budgetGel, 50000)
  const profile = r.of('profile')[0] as { items: { key: string }[] }
  assert.equal(profile.items.some((i) => i.key === 'budgetGel'), false, 'the old budget is not applied to this chat')
  assert.equal(r.of('form').length, 0, 'no fallback form on a recall turn')
})
