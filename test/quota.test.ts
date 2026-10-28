import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ApiError } from '@google/genai'
import { ai, AiUnavailableError } from '../src/modules/ai/ai.gateway.js'
import { quota } from '../src/modules/ai/ai.quota.js'
import { FREE_CHAT_MODELS, modelChains } from '../src/modules/ai/ai.models.js'
import { gemini } from '../src/pkg/gemini/gemini.js'
import { db } from '../src/pkg/supabase/supabase.js'

// The shared usage figure: answered requests out of the free daily total of the chat's models.

test('usage counts answered requests, a used-up model in full, and resets at midnight Pacific', () => {
  const models = ['test-model-a', 'test-model-b'] // unknown models: 20 a day each
  assert.deepEqual({ ...quota.usage(models), resetsAt: undefined }, { used: 0, total: 40, resetsAt: undefined })
  quota.recordOk('test-model-a')
  quota.recordOk('test-model-a')
  quota.recordOk('test-model-a')
  assert.equal(quota.usage(models).used, 3)
  quota.markExhausted('test-model-b') // Google said "retry in 21h": counts as all 20 used
  assert.equal(quota.usage(models).used, 23)
  const reset = new Date(quota.usage(models).resetsAt)
  assert.ok(reset.getTime() > Date.now() && reset.getTime() - Date.now() <= 25 * 3_600_000)
  assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }).format(reset).replace('24', '00'), '00', 'midnight Pacific')
})

test('the chat prefers 3.8 Flash and falls back through every free model (the order actually tried is learnt, below)', () => {
  assert.equal(modelChains.responder[0], 'gemini-3.8-flash')
  assert.deepEqual([...modelChains.responder], [...FREE_CHAT_MODELS])
})

test('busy attempts do not use up a model; Google saying "used up" does', async () => {
  // Flash-Lite allows 15 a minute: 25 attempts spread as if over time must not block it for the day.
  const model = 'gemini-3.5-flash-lite'
  for (let i = 0; i < 25; i++) {
    assert.equal(await quota.acquire(model, 0), i < 15, `attempt ${i + 1}: only the per-minute limit applies`)
  }
  const fresh = 'gemini-3.1-flash-lite'
  assert.equal(await quota.acquire(fresh, 0), true)
  quota.markExhausted(fresh)
  assert.equal(await quota.acquire(fresh, 0), false, 'used up until the reset')
})

test('the free total reflects the real limits: 5 Flash models × 20 and 3 Flash-Lite × 500 a day', () => {
  const { total } = quota.usage([...FREE_CHAT_MODELS])
  assert.equal(total, 5 * 20 + 3 * 500)
  const reset = new Date(quota.usage([...FREE_CHAT_MODELS]).resetsAt)
  assert.equal(reset.getUTCSeconds(), 0)
  assert.equal(reset.getUTCMinutes(), 0, 'renews on the hour, not a minute after')
})

// The order actually tried: learnt from recent calls. Failures and answers are recorded with their time, so a cool-off
// that ended minutes ago needs no clock tricks.

const min = 60_000
const ago = (m: number) => Date.now() - m * min

test('a model that keeps failing goes behind the healthy ones, waits longer after each failure in a row, and comes back', () => {
  const chain = ['flaky', 'steady-a', 'steady-b'] // unknown models: one tier block, chain order otherwise
  assert.deepEqual(quota.order(chain), chain)

  quota.recordSuccess('flaky', 3_000, 'responder', ago(120)) // it answered earlier today
  quota.recordFailure('flaky', ago(3)) // one failure: 2 min off, over by now
  assert.deepEqual(quota.order(chain), chain, 'back after its cool-off')
  quota.recordFailure('flaky', ago(1)) // two in a row: 5 min off
  assert.deepEqual(quota.order(chain), ['steady-a', 'steady-b', 'flaky'])
  assert.equal(quota.status('flaky').status, 'busy')

  // Three in a row wait 15 min, four 30 min.
  quota.recordSuccess('worse', 3_000, 'responder', ago(120))
  for (const at of [ago(40), ago(39), ago(18)]) quota.recordFailure('worse', at)
  assert.deepEqual(quota.order(['worse', 'steady-a']), ['worse', 'steady-a'], 'three failures, the last 18 min ago: back')
  quota.recordFailure('worse', ago(20))
  assert.deepEqual(quota.order(['worse', 'steady-a']), ['steady-a', 'worse'], 'four failures: 30 min off')
  // Of two models cooling off, the one back sooner is tried first.
  assert.deepEqual(quota.order(['worse', 'flaky', 'steady-a']), ['steady-a', 'flaky', 'worse'])
})

test('one answer ends the cool-off at once', () => {
  for (const at of [ago(3), ago(2), ago(1)]) quota.recordFailure('recovers', at)
  assert.deepEqual(quota.order(['recovers', 'other']), ['other', 'recovers'])
  quota.recordSuccess('recovers', 2_500, 'responder')
  assert.deepEqual(quota.order(['recovers', 'other']), ['recovers', 'other'])
  quota.recordFailure('recovers')
  assert.deepEqual(quota.order(['recovers', 'other']), ['other', 'recovers'], 'a new failure counts from one again: 2 min, not 30')
  assert.equal(quota.status('recovers').status, 'busy')
})

test('after a quiet hour, a model that failed all day without answering is tried after the ones that answered', () => {
  // 3.8 Flash on 2026-10-28: 1 answer in 57 calls. Nothing in the last hour, so the hour alone knows nothing.
  for (const at of [ago(600), ago(400), ago(200), ago(90)]) quota.recordFailure('dead-all-day', at)
  quota.recordSuccess('answered-today', 4_000, 'responder', ago(300))
  assert.deepEqual(quota.order(['dead-all-day', 'answered-today']), ['answered-today', 'dead-all-day'])
  assert.equal(quota.status('dead-all-day').status, 'available', 'not cooling off: still tried, only later')
})

test('one answer within the day keeps a model in front, even with failures after it', () => {
  for (const at of [ago(900), ago(700)]) quota.recordFailure('mostly-dead', at)
  quota.recordSuccess('mostly-dead', 9_000, 'responder', ago(20 * 60))
  quota.recordFailure('mostly-dead', ago(120))
  for (const at of [ago(500), ago(130)]) quota.recordFailure('never-answers', at)
  assert.deepEqual(quota.order(['never-answers', 'mostly-dead']), ['mostly-dead', 'never-answers'])
  quota.recordSuccess('never-answers', 2_000, 'responder')
  assert.deepEqual(quota.order(['never-answers', 'mostly-dead']), ['never-answers', 'mostly-dead'], 'one answer puts it back in front')
})

test('a model with no calls within the day keeps its chain position, between those that answered and those that only failed', () => {
  quota.recordFailure('only-fails', ago(240))
  quota.recordSuccess('answers', 5_000, 'responder', ago(180))
  assert.deepEqual(quota.order(['untried-a', 'only-fails', 'untried-b', 'answers']), ['answers', 'untried-a', 'untried-b', 'only-fails'])
  assert.deepEqual(quota.order(['untried-b', 'untried-a']), ['untried-b', 'untried-a'])
  // A day later the failure is forgotten too.
  quota.recordFailure('failed-long-ago', ago(25 * 60))
  assert.deepEqual(quota.order(['failed-long-ago', 'untried-a']), ['failed-long-ago', 'untried-a'])
})

test("within a tier the faster healthy model goes first; the tiers keep chainFor's order", () => {
  const chain = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']
  quota.recordSuccess('gemini-3.6-flash', 4_100, 'responder')
  quota.recordSuccess('gemini-3.5-flash', 3_300, 'responder')
  quota.recordSuccess('gemini-3-flash-preview', 3_000, 'responder')
  quota.recordSuccess('gemini-3.5-flash-lite', 16_800, 'responder')
  quota.recordSuccess('gemini-3.1-flash-lite', 4_000, 'responder')
  assert.deepEqual(quota.order(chain), [
    'gemini-3.5-flash', // 3.3 s and 3.0 s are a tie: the chain's preference decides
    'gemini-3-flash-preview',
    'gemini-3.6-flash',
    'gemini-3.8-flash', // not measured this hour: after the measured ones
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash-lite',
  ])
  // Speed is per task: the chat timings do not reorder search. Having answered at all is not: 3.8 Flash, untried,
  // still goes after the ones that answered.
  assert.deepEqual(quota.order(chain, 'search'), ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'])
  // A light question keeps Flash-Lite first, however fast the Flash models are.
  const light = [...chain.slice(4), ...chain.slice(0, 4)]
  assert.deepEqual(quota.order(light).slice(0, 2), ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'])
})

test('a model the client picked runs alone, however it did recently, and its failure is reported', async () => {
  const picked = 'gemini-3.7-flash'
  for (const at of [ago(3), ago(2), ago(1)]) quota.recordFailure(picked, at)
  const tried: string[] = []
  const saved = { stream: gemini.models.generateContentStream, from: db.from }
  gemini.models.generateContentStream = (async (p: { model: string }) => {
    tried.push(p.model)
    throw new ApiError({ message: 'This model is currently experiencing high demand.', status: 503 })
  }) as typeof gemini.models.generateContentStream
  db.from = (() => ({ insert: async () => ({ error: null }) })) as unknown as typeof db.from // no usage rows from a test
  try {
    const step = ai.agentStep({ system: 's', contents: [{ role: 'user', parts: [{ text: 'hi' }] }], tools: [], sessionId: 'test', only: picked })
    await assert.rejects(async () => {
      for await (const _ of step) void _
    }, AiUnavailableError)
    assert.deepEqual(tried, [picked], 'no other model is tried')
  } finally {
    gemini.models.generateContentStream = saved.stream
    db.from = saved.from
  }
})
