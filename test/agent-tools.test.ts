import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyFormAnswers, emptyOutput, runTool, type ToolContext } from '../src/modules/chat/agent/agent.tools.js'
import { standardForm } from '../src/modules/chat/agent/agent.fallback.js'
import { sessionStateSchema } from '../src/modules/chat/chat.model.js'
import type { CompareTable } from '../src/modules/chat/agent/agent.facts.js'

// The agent's deterministic tools: arithmetic and UI payloads need no model; listings are built in memory.

function ctx(): ToolContext {
  return {
    s: { cities: ['Tbilisi', 'Batumi'], categories: ['restaurants', 'bakery'], byId: new Map(), listings: [], rates: { GEL: 1, USD: 2.6, EUR: 2.9 } } as unknown as ToolContext['s'],
    sessionId: 'test',
    turn: 1,
    locale: 'ka',
    profile: {},
    state: sessionStateSchema.parse({}),
    out: emptyOutput(),
    progress: async () => {},
  }
}

const known = <T>(value: T) => ({ value, status: 'known' as const, turn: 1 })

test('calculate: payback and return from price and profit, with the owner salary deducted', async () => {
  const r = (await runTool('calculate', { price_gel: 40000, profit_monthly_gel: 2500 }, ctx())) as { result: { payback_months: number; annual_return_pct: number } }
  assert.equal(r.result.payback_months, 16)
  assert.equal(r.result.annual_return_pct, 75)
  const withSalary = (await runTool('calculate', { price_gel: 40000, profit_monthly_gel: 2500, owner_salary_monthly_gel: 1500 }, ctx())) as { result: { payback_months: number } }
  assert.equal(withSalary.result.payback_months, 40)
  const fast = (await runTool('calculate', { price_gel: 10000, profit_monthly_gel: 3000 }, ctx())) as { warning?: string }
  assert.match(fast.warning ?? '', /unusually fast/, 'a payback under 6 months is flagged')
  const bad = (await runTool('calculate', { price_gel: 60000 }, ctx())) as { error?: string }
  assert.match(bad.error ?? '', /profit_scenarios/, 'without profit it points to the scenarios')
})

test('profit_scenarios: three scenarios with the same cost lines, computed in code, and a table on screen', async () => {
  const c = ctx()
  const r = (await runTool(
    'profit_scenarios',
    { price_gel: 60000, revenue_monthly_gel: [30000, 20000, 25000], cost_of_goods_pct: 35, rent_monthly_gel: 3000, staff_monthly_gel: 6000, utilities_monthly_gel: 800, tax_pct_of_revenue: 1 },
    c,
  )) as { scenarios: { scenario: string; revenue_monthly_gel: number; fixed_costs_gel: number; net_profit_monthly_gel: number; payback_months: number | null }[]; warnings: string[] }
  assert.deepEqual(r.scenarios.map((x) => x.scenario), ['cautious', 'realistic', 'optimistic'])
  assert.deepEqual(r.scenarios.map((x) => x.revenue_monthly_gel), [20000, 25000, 30000], 'sorted, cautious lowest')
  // Rent 3 000 + staff 6 000 + utilities 800 as given, and the other costs the model left out at their usual 400.
  assert.ok(r.scenarios.every((x) => x.fixed_costs_gel === 10200), 'the same fixed costs in every scenario')
  // 20 000 − 35% (7 000) − 1% (200) − 10 200 = 2 600
  assert.equal(r.scenarios[0]!.net_profit_monthly_gel, 2600)
  assert.equal(r.scenarios[0]!.payback_months, 23)
  const table = c.out.compare as CompareTable
  assert.equal(table.kind, 'profit')
  assert.ok(table.rows.some((row) => row.key === 'staff') && table.rows.some((row) => row.key === 'payback'))
  assert.match(table.rows.find((row) => row.key === 'other')!.label, /ტიპური/, 'a usual figure says so')
  assert.match(table.rows.find((row) => row.key === 'owner_salary')!.label, /თქვენი შრომა/, "the owner's own work is shown as not counted")

  const tooGood = (await runTool('profit_scenarios', { price_gel: 15000, revenue_monthly_gel: [20000, 25000, 30000] }, ctx())) as { warnings: string[] }
  assert.ok(tooGood.warnings.some((w) => /under 6 months/.test(w)), 'a payback under 6 months is flagged')
  assert.ok(tooGood.warnings.some((w) => /Usual figures were used for staff/.test(w)), 'staff left out: the usual figure is used and called an assumption')
  const missing = (await runTool('profit_scenarios', { price_gel: 15000, revenue_monthly_gel: [20000] }, ctx())) as { error?: string }
  assert.ok(missing.error, 'three revenues are needed')
})

test('show_form: only while two or more key facts are unknown; the form itself is the standard one', async () => {
  const c = ctx()
  const r = (await runTool('show_form', {}, c)) as { shown?: boolean }
  assert.equal(r.shown, true)
  assert.equal(c.out.formRequested, true)

  const almost = { ...ctx(), profile: { budgetGel: known(50000), involvement: known('part_time' as const), cities: known(['Tbilisi']) } }
  const refused = (await runTool('show_form', {}, almost)) as { error?: string }
  assert.match(refused.error ?? '', /type/, 'one fact missing: ask it in the text instead')
  assert.equal(almost.out.formRequested, undefined)
})

test('the standard form is the same every time, with "other" and "any" last and known answers pre-selected', () => {
  const form = standardForm({ budgetGel: known(50000), sectors: known(['bakery']), cities: known(['Batumi']) }, 'ka')
  assert.deepEqual(form.questions.map((q) => q.field), ['budget', 'goal', 'involvement', 'location', 'sector'])
  const byField = Object.fromEntries(form.questions.map((q) => [q.field, q]))
  assert.deepEqual(byField.budget!.options.map((o) => o.value), ['30000', '80000', '200000', '600000'])
  assert.equal(byField.budget!.selected, '80000', '50 000 falls in the 30–80 000 bucket')
  assert.equal(byField.location!.selected, 'Batumi')
  assert.deepEqual(byField.location!.options.slice(-2).map((o) => o.value), ['other', 'any'])
  assert.equal(byField.sector!.selected, 'bakery')
  assert.deepEqual(byField.sector!.options.slice(-2).map((o) => o.value), ['other', 'any'])
  assert.ok(byField.sector!.options.some((o) => o.label.includes('კაფე')) && byField.sector!.options.some((o) => o.label.includes('ავტოსამრეცხაო')), 'real business types')
  assert.deepEqual(standardForm({}, 'ka'), standardForm({}, 'ka'), 'no randomness')
})

test('suggest_replies: up to three short chips', async () => {
  const c = ctx()
  await runTool('suggest_replies', { options: ['კი, მაჩვენე', 'ჯერ რისკები', 'შევადაროთ', 'სხვა ქალაქი'] }, c)
  assert.equal(c.out.quickReplies.length, 3)
  assert.equal(c.out.quickReplies[0]?.kind, 'message')
})

test('form answers fill the profile without a model', () => {
  const p = applyFormAnswers(
    {},
    [
      { field: 'budget', value: '80000' },
      { field: 'involvement', value: 'part_time' },
      { field: 'goal', value: 'passive_income' },
      { field: 'location', value: 'Tbilisi' },
      { field: 'sector', value: 'retail,supermarket,clothing_store' },
    ],
    ['Tbilisi', 'Batumi'],
    ['restaurants', 'bakery', 'retail', 'supermarket'],
    1,
  )
  assert.equal(p.budgetGel?.value, 80000)
  assert.equal(p.involvement?.value, 'part_time')
  assert.equal(p.goal?.value, 'passive_income')
  assert.deepEqual(p.cities?.value, ['Tbilisi'])
  assert.deepEqual(p.sectors?.value, ['retail', 'supermarket'], 'a type stands for the site categories it covers')
  const kept = applyFormAnswers({ budgetGel: known(50000) }, [{ field: 'budget', value: '80000' }], ['Tbilisi'], ['bakery'], 2)
  assert.equal(kept.budgetGel?.value, 50000, 'the pre-selected bucket keeps the stated budget')
  const any = applyFormAnswers({}, [{ field: 'location', value: 'any' }, { field: 'sector', value: 'any' }, { field: 'budget', value: 'lots' }], ['Tbilisi'], ['bakery'], 1)
  assert.equal(any.locationFlexible?.value, true)
  assert.deepEqual(any.sectors?.value, [])
  assert.equal(any.budgetGel, undefined, 'a non-number budget is ignored')
  const other = applyFormAnswers({}, [{ field: 'location', value: 'other' }, { field: 'sector', value: 'other' }], ['Tbilisi'], ['bakery'], 1)
  assert.deepEqual(other, {}, '"other" leaves the fact open for the model to ask')
})

async function withListings(titles: string[], fn: (c: () => ToolContext, ids: string[]) => Promise<void>) {
  const { catalog, toListing } = await import('../src/modules/catalog/catalog.service.js')
  const rates = { GEL: 1, USD: 2.6, EUR: 2.9 }
  const listings = titles.map((title, i) =>
    toListing({ id: `${i + 1}`.repeat(8) + `-0000-4000-8000-00000000000${i + 1}`, title, category: 'restaurants', deal_type: 'sale', price: 50000 + i, currency: 'GEL', city: 'Tbilisi', description: 'მოქმედი კაფე, ქირა 1000$ თვეში, დღიური ბრუნვა 700-800 ლარი' }, rates),
  )
  const s = { cities: ['Tbilisi'], categories: ['restaurants'], rates, listings, byId: new Map(listings.map((l) => [l.id, l])), byShortId: new Map(listings.map((l) => [l.shortId, l])), stats: new Map() } as unknown as ToolContext['s']
  const original = catalog.fetch
  catalog.fetch = async (_s, ref) => {
    const l = listings.find((x) => ref.startsWith(x.shortId) || ref === x.id)
    return l ? { snapshot: s, listing: l } : 'unavailable'
  }
  try {
    await fn(() => ({ ...ctx(), s, state: sessionStateSchema.parse({}) }), listings.map((l) => l.id))
  } finally {
    catalog.fetch = original
  }
}

test('get_listing: numbered once, its card shown once, and a fact sheet with the rent and daily turnover read right', async () => {
  await withListings(['იყიდება კაფე ვაკეში'], async (make, [id]) => {
    const first = make()
    const r = (await runTool('get_listing', { ref: id!.slice(0, 8) }, first)) as { fact_sheet: { ref: string; name: string; rent: string; turnover: string; price: string } }
    assert.equal(first.out.cards.length, 1, 'shown the first time')
    assert.equal(first.out.cards[0]!.n, 1)
    assert.equal(r.fact_sheet.ref, '#1')
    assert.equal(r.fact_sheet.name, 'კაფე, ვაკე', 'the kind and the district named in the title')
    assert.match(r.fact_sheet.rent, /^≈ 2\s600 ₾\/თვე \(\$1\s000\)$/, 'ready to quote: lari per month, the dollars as written, no label')
    assert.match(r.fact_sheet.turnover, /^≈ 21\s000–24\s000 ₾\/თვე \(700–800 ₾ დღეში\)$/, 'a daily figure is never passed off as monthly')
    assert.doesNotMatch(JSON.stringify(r.fact_sheet), /USD/, 'no "USD" in a Georgian fact sheet')
    const again = { ...make(), state: { ...first.state, cardsShown: [id!] } }
    const r2 = (await runTool('get_listing', { ref: '#1' }, again)) as { card: string }
    assert.equal(again.out.cards.length, 0, 'not shown again')
    assert.match(r2.card, /already in this chat/)
  })
})

test('compare: all listings on screen unless the message names some; the table is numbered like the cards', async () => {
  const { namesSpecificListings } = await import('../src/modules/chat/agent/agent.tools.js')
  await withListings(['იყიდება კაფე ვაკეში', 'საკონდიტრო ისანში', 'ლუდის მაღაზია საბურთალოზე'], async (make, ids) => {
    const run = async (userText: string, refs: string[]) => {
      const c = { ...make(), userText }
      c.state.lastShown = ids
      c.state.refs = [...ids]
      // Known places: the comparison reuses them instead of reading the map again.
      for (const id of ids) c.state.places[id] = { radiusM: 300, direct: 4, within150m: 1, nearest: ['A (40 m)'], precision: 'street' }
      await runTool('compare_listings', { refs }, c)
      return c.out.compare as CompareTable
    }
    // The model passed only two, but the client asked about all of them.
    assert.equal((await run('მომეცი შედარების სტატისტიკა', [ids[0]!.slice(0, 8), ids[1]!.slice(0, 8)])).heads.length, 3)
    const all = await run('Compare them, pros and cons and scores', [])
    assert.deepEqual(all.heads.map((h) => h.n), [1, 2, 3])
    const competitors = all.rows.find((r) => r.key === 'competitors')!
    assert.deepEqual(competitors.values, ['4 — 300 მ-ში', '4 — 300 მ-ში', '4 — 300 მ-ში'], 'one count, one radius')
    assert.ok(!all.rows.some((r) => r.key === 'profit'), 'a row empty for every listing is hidden')
    const revenue = all.rows.find((r) => r.key === 'revenue')!
    assert.match(revenue.values[0]!, /21\s000–24\s000 ₾\/თვე \(700–800 ₾ დღეში\)/)
    // The client named two.
    assert.equal((await run('შეადარე პირველი და მეორე', [ids[0]!.slice(0, 8), ids[1]!.slice(0, 8)])).heads.length, 2)
    assert.equal((await run('#3 და #1 შეადარე', ['#3', '#1'])).heads.length, 2)
  })
  assert.equal(namesSpecificListings('რომელი ჯობია?', []), false)
  assert.equal(namesSpecificListings('compare #1 and #3', []), true)
  assert.equal(namesSpecificListings('Сравни оба', []), true)
})

test('seller_message and visit_checklist go on screen for the right listing', async () => {
  await withListings(['იყიდება კაფე ვაკეში'], async (make, [id]) => {
    const c = make()
    await runTool('seller_message', { ref: id!.slice(0, 8), message: 'გამარჯობა, მაინტერესებს თქვენი კაფე. რამდენია რეალური თვიური ბრუნვა და რატომ ყიდით?' }, c)
    assert.equal(c.out.handoff?.n, 1)
    assert.match(c.out.handoff?.url ?? '', /mybusiness\.ge\/ka\/listing\//)
    const short = (await runTool('seller_message', { ref: '#1', message: 'hi' }, make())) as { error?: string }
    assert.ok(short.error, 'an empty message is refused')
    const v = make()
    await runTool('visit_checklist', { ref: '#1', items: ['ნახეთ სალარო', 'შეამოწმეთ აღჭურვილობა', 'დაითვალეთ მომხმარებლები'] }, { ...v, state: c.state })
    assert.equal(v.out.checklist?.items.length, 3)
  })
})
