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
