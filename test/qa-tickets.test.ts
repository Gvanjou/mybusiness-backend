import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyFormAnswers, emptyOutput, runTool, type ToolContext } from '../src/modules/chat/agent/agent.tools.js'
import { keepStatedBudget } from '../src/modules/chat/agent/agent.fallback.js'
import { sessionStateSchema } from '../src/modules/chat/chat.model.js'
import { profileItems } from '../src/modules/chat/templates/templates.js'
import { val } from '../src/modules/chat/profile/profile.model.js'

// QA bug tickets of 5 Nov 2026 (MB-01, MB-02).

const known = <T>(value: T) => ({ value, status: 'known' as const, turn: 1 })

function ctx(profile: ToolContext['profile']): ToolContext {
  return {
    s: { cities: ['Tbilisi'], categories: ['restaurants', 'bar_nightclub'], byId: new Map(), listings: [], rates: { GEL: 1, USD: 2.6, EUR: 2.9 } } as unknown as ToolContext['s'],
    sessionId: 'test',
    turn: 2,
    locale: 'ka',
    profile,
    state: sessionStateSchema.parse({}),
    out: emptyOutput(),
    progress: async () => {},
  }
}

test('MB-01: "50 000 ₾" never becomes the 80 000 top of the range the form showed', async () => {
  assert.equal(keepStatedBudget(80000, 50000), 50000)
  assert.equal(keepStatedBudget(80000, 20000), 80000, 'a stated budget below the range is a real change')
  assert.equal(keepStatedBudget(75000, 50000), 75000, 'a number that is not a range top is the client’s')
  // The form keeps it…
  const formed = applyFormAnswers({ budgetGel: known(50000) }, [{ field: 'budget', value: '80000' }], ['Tbilisi'], ['restaurants'], 2)
  assert.equal(val(formed, 'budgetGel'), 50000)
  // …and so does the model's update_profile with the range top.
  const c = ctx({ budgetGel: known(50000) })
  await runTool('update_profile', { budget_gel: 80000 }, c)
  assert.equal(val(c.profile, 'budgetGel'), 50000)
  await runTool('update_profile', { budget_amount: 80000, budget_currency: 'GEL' }, c)
  assert.equal(val(c.profile, 'budgetGel'), 50000)
  const memory = profileItems(c.profile, 'ka').find((i) => i.key === 'budgetGel')!
  assert.match(memory.value, /50\s000/)
})

test('MB-02: one form choice shows as one business type in memory, not every category behind it', () => {
  const p = applyFormAnswers({}, [{ field: 'sector', value: 'restaurants,bar_nightclub' }], ['Tbilisi'], ['restaurants', 'bar_nightclub'], 2)
  const memory = profileItems(p, 'ka').find((i) => i.key === 'sectors')!
  assert.equal(memory.value, 'კაფე / რესტორანი')
  const single = profileItems({ sectors: known(['bar_nightclub']) }, 'en').find((i) => i.key === 'sectors')!
  assert.match(single.value, /Bar/, 'a category on its own keeps its own name')
})

test('MB-08: a listing posted more than 90 days ago is flagged with its age, a recent one is not', async () => {
  const { monthsListed } = await import('../src/modules/chat/agent/agent.facts.js')
  const now = Date.parse('2026-11-05T10:00:00Z')
  const at = (iso: string) => ({ createdAt: iso }) as Parameters<typeof monthsListed>[0]
  assert.equal(monthsListed(at('2026-05-12T10:00:00Z'), now), 5)
  assert.equal(monthsListed(at('2026-09-20T10:00:00Z'), now), null)
  assert.equal(monthsListed({ createdAt: null } as Parameters<typeof monthsListed>[0], now), null)
})
