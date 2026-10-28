import assert from 'node:assert/strict'
import { test } from 'node:test'
import { quota } from '../src/modules/ai/ai.quota.js'
import { FREE_CHAT_MODELS, modelChains } from '../src/modules/ai/ai.models.js'

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

test('the chat tries 3.8 Flash first and falls back through every free model', () => {
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
