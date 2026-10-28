import assert from 'node:assert/strict'
import { test } from 'node:test'
import { textInsights } from '../src/modules/catalog/catalog.text.js'

// Facts read from the listing text without AI (used while a listing has no AI notes yet).

const site = { employees: null, yearEstablished: null, revenueMonthly: null, incomeMonthly: null, currency: 'USD' }
const poke = [
  'Poke Bar — ჩამოყალიბებული, სწრაფად მზარდი ჯანსაღი კვების ბრენდი, რომელიც 2020 წლიდან საქმიანობს თბილისში. ვაკის ფლაგმანური რესტორანი და ორი dark kitchen-ი (საბურთალო, დიღომი). სრულად ფუნქციონირებადი გუნდი (20 თანამშრომელი). Wolt 9.6/10, Glovo 99%, Bolt 4.9/5. განმეორებითი მომხმარებლების 67%-იანი წილი. დეტალური ფინანსური მონაცემები (P&L, შემოსავალი, ხარჯები) ხელმისაწვდომია მოთხოვნის შემთხვევაში.',
  'Poke Bar — an established, fast-growing healthy food brand operating in Tbilisi since 2020. A flagship restaurant plus two dark kitchens. Fully functioning team (20 employees), brand, menu and supplier network. High ratings on delivery platforms: Wolt 9.6/10, Glovo 99%, Bolt 4.9/5. 67% repeat customers. Detailed financials (P&L, revenue, expenses) available on request for serious buyers.',
]

test('reads the seller’s facts from a description in two languages, each once', () => {
  const i = textInsights({ category: 'restaurants', dealType: 'sale', texts: poke, site, hasLocation: true, priceKnown: true })
  assert.equal(i.source, 'text')
  assert.equal(i.staff.count, 20)
  assert.equal(i.yearsOperating, new Date().getFullYear() - 2020)
  assert.deepEqual(i.highlights?.ratings, [
    { platform: 'Wolt', value: '9.6/10' },
    { platform: 'Glovo', value: '99%' },
    { platform: 'Bolt', value: '4.9/5' },
  ])
  assert.equal(i.highlights?.repeatPct, 67)
  assert.deepEqual(i.highlights?.sites, [{ count: 2, kind: 'dark_kitchen' }])
  assert.equal(i.highlights?.onRequest, true)
  assert.equal(i.financials.revenue_monthly, null, 'no figures invented')
  assert.ok(i.includedAssets.includes('brand') && i.includedAssets.includes('supplier network'))
  assert.equal(new Set(i.strengths).size, i.strengths.length, 'no duplicates')
})

test('takes stated monthly figures, never the asking price, and prefers the site fields', () => {
  const i = textInsights({
    category: 'bakery',
    dealType: 'sale',
    texts: ['Price 60 000 GEL. Monthly revenue 25 000 GEL, net profit 4 000 GEL per month. The premises are leased.'],
    site: { ...site, currency: 'GEL', employees: 4 },
    hasLocation: false,
    priceKnown: true,
  })
  assert.equal(i.financials.revenue_monthly?.min, 25000)
  assert.equal(i.financials.profit_monthly?.min, 4000)
  assert.equal(i.premises.tenure, 'leased')
  assert.equal(i.staff.count, 4)
})
