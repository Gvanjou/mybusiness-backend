import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
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
const stored: { role: string; content: string }[] = []

before(() => {
  chatRepository.addMessage = async (_id, m) => stored.push(m)
  chatRepository.recentMessages = async () => []
  chatRepository.saveSession = async () => {}
  ai.agentStep = ((params: Step) => {
    if (!script) throw new AiUnavailableError('responder')
    return script(params, ++calls)
  }) as typeof ai.agentStep
})
after(() => {
  Object.assign(chatRepository, saved)
  ai.agentStep = original
})

async function run(text: string) {
  const session: Session = { id: '00000000-0000-4000-8000-000000000001', userId: 'test-user', title: null, locale: 'ka', profile: {}, state: sessionStateSchema.parse({}), turnCount: 0, expiresAt: new Date() }
  const events: { event: string; data: unknown }[] = []
  calls = 0
  await agentTurn({ session, input: { text }, emit: async (event, data) => void events.push({ event, data }), signal: new AbortController().signal })
  const tokens = events.filter((e) => e.event === 'token').map((e) => (e.data as { text: string }).text).join('')
  return { events, tokens, of: (name: string) => events.filter((e) => e.event === name).map((e) => e.data) }
}

test('tool calls run, their results reach the next step, and the form/profile events go out', async () => {
  const seen: Step[] = []
  script = async function* (params, n) {
    seen.push(params)
    if (n === 1) {
      yield { type: 'text', text: 'ჯერ რამდენიმე კითხვა.' }
      const c1 = { name: 'update_profile', args: { budget_gel: 50000, involvement: 'part_time' } }
      const c2 = { name: 'show_form', args: { questions: [{ field: 'goal', question: 'რა არის მიზანი?', options: [{ value: 'passive_income', label: 'შემოსავალი' }, { value: 'own_job', label: 'ჩემი საქმე' }] }], submit_label: 'გაგრძელება' } }
      yield { type: 'done', model: 'stub', parts: [{ text: 'ჯერ რამდენიმე კითხვა.' }, { functionCall: c1 }, { functionCall: c2 }], calls: [c1, c2] }
      return
    }
    yield { type: 'text', text: 'შეავსეთ და გავაგრძელოთ.' }
    yield { type: 'done', model: 'stub', parts: [{ text: 'შეავსეთ და გავაგრძელოთ.' }], calls: [] }
  }
  const r = await run('მინდა ბიზნესის ყიდვა, არ ვიცი რომელი')
  assert.equal(calls, 2, 'a step with a non-terminal tool continues; the text-only step ends it')
  assert.equal(r.tokens, 'ჯერ რამდენიმე კითხვა.\n\nშეავსეთ და გავაგრძელოთ.')
  const form = r.of('form')[0] as { questions: { field: string }[]; submitLabel: string }
  assert.deepEqual(form.questions.map((q) => q.field), ['goal'])
  const profile = r.of('profile')[0] as { items: { key: string; value: string }[] }
  assert.ok(profile.items.some((i) => i.key === 'budgetGel' && i.value.includes('50')), 'update_profile applied the budget')
  assert.ok(profile.items.some((i) => i.key === 'involvement'))
  assert.equal(r.events.at(-1)?.event, 'done')
  // The second step received the model's own parts and one function response per call, in order.
  const step2 = seen[1]!.contents
  const modelTurn = step2.at(-2)!
  const toolTurn = step2.at(-1)!
  assert.equal(modelTurn.role, 'model')
  assert.equal(toolTurn.role, 'user')
  assert.deepEqual((toolTurn.parts ?? []).map((p) => p.functionResponse?.name), ['update_profile', 'show_form'])
  assert.equal(seen[1]!.tools.length > 0, true, 'tools are still offered on the second step')
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
    const c = { name: 'show_form', args: { questions: [{ field: 'goal', question: 'მიზანი?', options: [{ value: 'growth', label: 'ზრდა' }, { value: 'own_job', label: 'საქმე' }] }], submit_label: 'OK' } }
    yield { type: 'done', model: 'stub', parts: [{ functionCall: c }], calls: [c] }
  }
  const r = await run('დამეხმარე არჩევაში')
  assert.ok(r.tokens.length > 10, 'some text goes out')
  assert.equal(r.of('form').length, 1)
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
