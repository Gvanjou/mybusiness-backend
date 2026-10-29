import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CatalogListing } from '../src/modules/catalog/catalog.model.js'
import { citiesNamed } from '../src/modules/catalog/catalog.labels.js'
import { areaOf } from '../src/modules/catalog/catalog.service.js'
import { fixScript } from '../src/modules/chat/agent/agent.text.js'
import { detectLanguage } from '../src/modules/chat/router/router.rules.js'

// The tester's implementation report (29 Oct): the text-side rules that need no AI.

test('a Georgian word with Greek or other foreign letters in it loses them; a word in another script stays', () => {
  assert.equal(fixScript('ασსაფრთხოა და Wolt-ზე', 'ka'), 'საფრთხოა და Wolt-ზე')
  assert.equal(fixScript('პլუსები', 'ka'), 'პლუსები', 'an Armenian lookalike becomes its Georgian letter')
  assert.equal(fixScript('მენიუ Glovo, Bolt 4.9', 'ka'), 'მენიუ Glovo, Bolt 4.9')
  assert.equal(fixScript('Цена и прoфит', 'ru'), 'Цена и профит', 'Russian keeps its own rule')
})

test('an area that is really the price, or absurd for the kind of business, counts as not stated', () => {
  const listing = (over: Partial<CatalogListing>): CatalogListing => ({ category: 'cafe', price: 62000, area: 62000, insights: null, ...over }) as CatalogListing
  assert.equal(areaOf(listing({})), null, 'the price typed into the area field')
  assert.equal(areaOf(listing({ area: 45 })), 45)
  assert.equal(areaOf(listing({ area: 12000 })), null, 'no café is 12 000 m²')
  assert.equal(areaOf(listing({ area: 12000, category: 'warehouse' })), 12000, 'a warehouse can be')
  assert.equal(areaOf(listing({ area: null })), null)
})

test('Georgian typed on a Latin keyboard is not English: the conversation keeps its language', () => {
  assert.equal(detectLanguage('rogor xdeba es?', 'ka'), 'ka')
  assert.equal(detectLanguage('kafe batumshi 30000', 'ka'), 'ka')
  assert.equal(detectLanguage('how much is the cafe in Batumi?', 'ka'), 'en')
  assert.equal(detectLanguage('сколько стоит кафе?', 'ka'), 'ru')
  assert.equal(detectLanguage('მინდა კაფე', 'en'), 'ka')
})

test('cities named in a message, with their endings, in three languages; a short name never matches a street', () => {
  assert.deepEqual(citiesNamed('ავტოსამრეცხაო მინდა ბათუმში'), ['Batumi'])
  assert.deepEqual(citiesNamed('кафе в Тбилиси'), ['Tbilisi'])
  assert.deepEqual(citiesNamed('a café in Batumi'), ['Batumi'])
  assert.deepEqual(citiesNamed('გორგასლის ქუჩაზე'), [])
})
