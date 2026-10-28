import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyFormAnswers, runTool, type ToolContext } from '../src/modules/chat/agent/agent.tools.js'

// The agent's deterministic tools: arithmetic and UI payloads need no catalogue, no model and no network.

function ctx(): ToolContext {
  return {
    s: { cities: ['Tbilisi', 'Batumi'], categories: ['restaurants', 'bakery'], byId: new Map(), listings: [] } as unknown as ToolContext['s'],
    sessionId: 'test',
    turn: 1,
    locale: 'ka',
    profile: {},
    state: { asked: [], discoveryTurns: 0, lastShown: [], shownCount: 0, budgetRealityShown: false, aspectsAsked: [], reasked: [], lastTopics: [], cardsShown: [] },
    out: { cards: [], compare: null, sources: [], quickReplies: [], form: null },
    progress: async () => {},
  }
}

test('calculate: payback and return from price and profit, with the owner salary deducted', async () => {
  const r = (await runTool('calculate', { price_gel: 40000, profit_monthly_gel: 2500 }, ctx())) as { result: { payback_months: number; annual_return_pct: number } }
  assert.equal(r.result.payback_months, 16)
  assert.equal(r.result.annual_return_pct, 75)
  const withSalary = (await runTool('calculate', { price_gel: 40000, profit_monthly_gel: 2500, owner_salary_monthly_gel: 1500 }, ctx())) as { result: { payback_months: number } }
  assert.equal(withSalary.result.payback_months, 40)
  const revenueOnly = (await runTool('calculate', { price_gel: 60000, revenue_monthly_gel: 20000 }, ctx())) as { at_margin: unknown[] }
  assert.equal(revenueOnly.at_margin.length, 3, 'revenue alone gives illustrations, not a payback')
  const bad = (await runTool('calculate', { price_gel: 60000 }, ctx())) as { error?: string }
  assert.ok(bad.error)
})

test('show_form: keeps valid questions, one per field, and ends the turn with a form', async () => {
  const c = ctx()
  const r = (await runTool(
    'show_form',
    {
      title: 'რამდენიმე კითხვა',
      questions: [
        { field: 'budget', question: 'რამდენის ჩადება შეგიძლიათ?', options: [{ value: '30000', label: '30 000 ₾-მდე' }, { value: '70000', label: '30–70 000 ₾' }] },
        { field: 'budget', question: 'duplicate', options: [{ value: '1', label: 'a' }, { value: '2', label: 'b' }] },
        { field: 'nonsense', question: 'x', options: [{ value: '1', label: 'a' }, { value: '2', label: 'b' }] },
        { field: 'goal', question: 'რა არის მიზანი?', options: [{ value: 'passive_income', label: 'შემოსავალი' }] },
        { field: 'involvement', question: 'რამდენი დრო?', options: [{ value: 'part_time', label: 'ნაწილობრივ' }, { value: 'full_time', label: 'სრულად' }] },
      ],
      submit_label: 'გაგრძელება',
    },
    c,
  )) as { shown: number }
  assert.equal(r.shown, 2, 'duplicate, unknown and single-option questions are dropped')
  assert.deepEqual(c.out.form?.questions.map((q) => q.field), ['budget', 'involvement'])
  assert.equal(c.out.form?.submitLabel, 'გაგრძელება')
})

test('suggest_replies: up to four short chips', async () => {
  const c = ctx()
  await runTool('suggest_replies', { options: ['კი, მაჩვენე', 'ჯერ რისკები', 'შევადაროთ', 'სხვა ქალაქი', 'მეხუთე'] }, c)
  assert.equal(c.out.quickReplies.length, 4)
  assert.equal(c.out.quickReplies[0]?.kind, 'message')
})

test('form answers fill the profile without a model', () => {
  const p = applyFormAnswers(
    {},
    [
      { field: 'budget', value: '70000' },
      { field: 'capital_source', value: 'savings' },
      { field: 'involvement', value: 'part_time' },
      { field: 'goal', value: 'passive_income' },
      { field: 'risk', value: 'low' },
      { field: 'location', value: 'Tbilisi' },
      { field: 'sector', value: 'bakery' },
      { field: 'experience', value: 'none' },
    ],
    ['Tbilisi', 'Batumi'],
    ['restaurants', 'bakery'],
    1,
  )
  assert.equal(p.budgetGel?.value, 70000)
  assert.equal(p.capitalShare?.value, 'all')
  assert.equal(p.involvement?.value, 'part_time')
  assert.equal(p.goal?.value, 'passive_income')
  assert.deepEqual(p.cities?.value, ['Tbilisi'])
  assert.deepEqual(p.sectors?.value, ['bakery'])
  const any = applyFormAnswers({}, [{ field: 'location', value: 'any' }, { field: 'sector', value: 'any' }, { field: 'budget', value: 'lots' }], ['Tbilisi'], ['bakery'], 1)
  assert.equal(any.locationFlexible?.value, true)
  assert.deepEqual(any.sectors?.value, [])
  assert.equal(any.budgetGel, undefined, 'a non-number budget is ignored')
})

test('get_listing: a card already in the conversation is not shown again', async () => {
  const { catalog, toListing } = await import('../src/modules/catalog/catalog.service.js')
  const rates = { GEL: 1, USD: 2.6, EUR: 2.9 }
  const listing = toListing({ id: '9d281948-daf7-49cd-9821-f9a94f04c7ea', title: 'კაფე ვაკეში', category: 'restaurants', deal_type: 'sale', price: 50000, currency: 'GEL', city: 'Tbilisi', description: 'მოქმედი კაფე' }, rates)
  const s = { ...ctx().s, rates, listings: [listing], byId: new Map([[listing.id, listing]]), byShortId: new Map([[listing.shortId, listing]]), stats: new Map() } as unknown as ToolContext['s']
  const original = catalog.fetch
  catalog.fetch = async () => ({ snapshot: s, listing })
  try {
    const first = { ...ctx(), s }
    await runTool('get_listing', { ref: listing.shortId }, first)
    assert.equal(first.out.cards.length, 1, 'shown the first time')
    const again = { ...ctx(), s, state: { ...ctx().state, cardsShown: [listing.id] } }
    const r = (await runTool('get_listing', { ref: listing.shortId }, again)) as { card: string }
    assert.equal(again.out.cards.length, 0, 'not shown again')
    assert.match(r.card, /already on screen/)
  } finally {
    catalog.fetch = original
  }
})

test("show_form: the model's own field names are mapped to ours", async () => {
  const c = ctx()
  const r = (await runTool(
    'show_form',
    {
      questions: [
        { field: 'budget_gel', question: 'ბიუჯეტი?', options: [{ value: '30000', label: '30 000' }, { value: '70000', label: '70 000' }] },
        { field: 'city', question: 'ქალაქი?', options: [{ value: 'Tbilisi', label: 'თბილისი' }, { value: 'any', label: 'ნებისმიერი' }] },
        { field: 'business_type', question: 'სფერო?', options: [{ value: 'restaurants', label: 'კაფე' }, { value: 'any', label: 'ნებისმიერი' }] },
        { field: 'favourite_colour', question: '?', options: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }] },
      ],
      submit_label: 'OK',
    },
    c,
  )) as { shown: number }
  assert.equal(r.shown, 3)
  assert.deepEqual(c.out.form?.questions.map((q) => q.field), ['budget', 'location', 'sector'])
})

test('compare: all listings on screen unless the message names particular ones', async () => {
  const { catalog, toListing } = await import('../src/modules/catalog/catalog.service.js')
  const { namesSpecificListings } = await import('../src/modules/chat/agent/agent.tools.js')
  const rates = { GEL: 1, USD: 2.6, EUR: 2.9 }
  const make = (n: number, title: string) =>
    toListing({ id: `${n}${n}${n}${n}${n}${n}${n}${n}-0000-4000-8000-00000000000${n}`, title, category: 'restaurants', deal_type: 'sale', price: 50000 + n, currency: 'GEL', city: 'Tbilisi', description: 'მოქმედი' }, rates)
  const three = [make(1, 'იყიდება კაფე ვაკეში'), make(2, 'საკონდიტრო ისანში'), make(3, 'ლუდის მაღაზია საბურთალოზე')]
  const s = { ...ctx().s, rates, listings: three, byId: new Map(three.map((l) => [l.id, l])), byShortId: new Map(three.map((l) => [l.shortId, l])), stats: new Map() } as unknown as ToolContext['s']
  const original = catalog.fetch
  catalog.fetch = async (_s, ref) => {
    const l = three.find((x) => ref.startsWith(x.shortId) || ref === x.id)
    return l ? { snapshot: s, listing: l } : 'unavailable'
  }
  const run = async (userText: string, refs: string[]) => {
    const c = { ...ctx(), s, userText, state: { ...ctx().state, lastShown: three.map((l) => l.id) } }
    await runTool('compare_listings', { refs }, c)
    return c.out.cards.map((x) => x.title)
  }
  try {
    // The model passed only two, but the client asked about all of them.
    assert.equal((await run('მომეცი შედარების სტატისტიკა', [three[0]!.shortId, three[1]!.shortId])).length, 3)
    assert.equal((await run('Compare them, pros and cons and scores', [])).length, 3)
    // The client named two.
    assert.equal((await run('შეადარე პირველი და მეორე', [three[0]!.shortId, three[1]!.shortId])).length, 2)
    assert.equal((await run('ლუდის მაღაზია და კაფე შეადარე', [three[2]!.shortId, three[0]!.shortId])).length, 2)
  } finally {
    catalog.fetch = original
  }
  assert.equal(namesSpecificListings('რომელი ჯობია?', three), false)
  assert.equal(namesSpecificListings('compare #1 and #3', three), true)
  assert.equal(namesSpecificListings('Сравни оба', three), true)
})
