import { pick, type Locale, type Localized } from '../../../shared/i18n/locale.js'
import { questions, type QuestionId } from '../planner/planner.questions.js'
import { has, val, type Profile } from '../profile/profile.model.js'
import type { IntakeForm } from './agent.model.js'

// The intake form is the same every time: the same questions, the same budget buckets, the same cities and real
// business types, "Other" and "Any" last. What the client already said is pre-selected, never asked again. The model
// only decides when to show it, and only while two or more key facts are missing.

// What the reply promised must be on screen. When the model writes "fill in the questions below" but no form came
// with it, or "here are the options" without searching, the app delivers it itself — whatever the model did.

// An invitation to fill something in ("შეავსეთ კითხვარი", "fill in the form", "заполните анкету") — not just any
// mention of questions ("questions to ask the seller" is not a form).
const PROMISES_FORM = /შეავს(?:ე|ოთ|ებ)|(?:უპასუხე|უპასუხოთ)[^.?!\n]{0,40}კითხვ|fill (?:in|out)|answer (?:these|the following|a few) (?:short )?questions|заполн|ответьте на (?:несколько )?вопрос/i
// "Let's look at the options / here are the listings" — a promise of listings, not just any action.
const PROMISES_LISTINGS = /ვარიანტ|განცხადებ|შეთავაზებ|\boptions\b|\blistings\b|businesses for sale|вариант|объявлен|предложени/i

export function promisesForm(text: string): boolean {
  return PROMISES_FORM.test(text.trim().slice(-300))
}

export function promisesListings(text: string): boolean {
  const tail = text.trim().slice(-260)
  return !tail.endsWith('?') && PROMISES_LISTINGS.test(tail)
}

const t = (ka: string, en: string, ru: string): Localized => ({ ka, en, ru })

const TITLE = t('რამდენიმე მოკლე კითხვა', 'A few quick questions', 'Несколько коротких вопросов')
const SUBMIT = t('გაგრძელება', 'Continue', 'Продолжить')
const NOTE = t('კიდევ რამე, რაც მნიშვნელოვანია? (არასავალდებულო)', 'Anything else that matters? (optional)', 'Что-то ещё важное? (необязательно)')

// The key facts a shortlist needs. Two or more missing → the form; one missing → one question in the text.
export type KeyFact = 'budget' | 'time' | 'city' | 'type'

export function missingKeyFacts(p: Profile): KeyFact[] {
  const out: KeyFact[] = []
  if (!has(p, 'budgetGel')) out.push('budget')
  if (!has(p, 'involvement') && !has(p, 'goal')) out.push('time')
  if (!has(p, 'cities') && !has(p, 'locationFlexible')) out.push('city')
  if (!has(p, 'sectors')) out.push('type')
  return out
}

// When the intake form is the right next step: two or more key facts unknown, unless the client already named both
// the kind of business and the budget ("რესტორანი მინდა, 50 ათასი"). Then they see listings at once, with one
// question about what is still missing (the decision after round 6, which found the two rules disagreeing).
export function formWanted(p: Profile): boolean {
  const missing = missingKeyFacts(p)
  return missing.length >= 2 && (missing.includes('type') || missing.includes('budget'))
}

// Budget buckets: the value is the upper bound in GEL (the top bucket stands for "more than 200 000").
const BUDGET: [number, Localized][] = [
  [30_000, t('30 000 ₾-მდე', 'Up to 30,000 ₾', 'До 30 000 ₾')],
  [80_000, t('30 000–80 000 ₾', '30,000–80,000 ₾', '30 000–80 000 ₾')],
  [200_000, t('80 000–200 000 ₾', '80,000–200,000 ₾', '80 000–200 000 ₾')],
  [600_000, t('200 000 ₾-ზე მეტი', 'More than 200,000 ₾', 'Более 200 000 ₾')],
]

export function budgetBucket(gel: number): number {
  return (BUDGET.find(([top]) => gel <= top) ?? BUDGET[BUDGET.length - 1]!)[0]
}

// The bucket's lower bound, so a stated budget inside the picked bucket is kept as it is (50 000, not 80 000).
export function bucketFloor(top: number): number {
  const i = BUDGET.findIndex(([x]) => x === top)
  return i > 0 ? BUDGET[i - 1]![0] : 0
}

export const CITIES: [string, Localized][] = [
  ['Tbilisi', t('თბილისი', 'Tbilisi', 'Тбилиси')],
  ['Batumi', t('ბათუმი', 'Batumi', 'Батуми')],
  ['Kutaisi', t('ქუთაისი', 'Kutaisi', 'Кутаиси')],
  ['Rustavi', t('რუსთავი', 'Rustavi', 'Рустави')],
  ['other', t('სხვა ქალაქი', 'Another city', 'Другой город')],
  ['any', t('ნებისმიერი', 'Any', 'Любой')],
]

// Real business types. A value can stand for several categories of the site ("retail,supermarket,…").
export const SECTOR_OPTIONS: [string, Localized][] = [
  ['restaurants,bar_nightclub', t('კაფე / რესტორანი', 'Café / restaurant', 'Кафе / ресторан')],
  ['bakery', t('საცხობი / საკონდიტრო', 'Bakery / pastry', 'Пекарня / кондитерская')],
  ['beauty_sport,spa', t('სილამაზის სალონი', 'Beauty salon', 'Салон красоты')],
  ['retail,supermarket,clothing_store', t('მაღაზია', 'Shop', 'Магазин')],
  ['car_wash,car_service', t('ავტოსამრეცხაო / სერვისი', 'Car wash / service', 'Автомойка / сервис')],
  ['services,cleaning,printing', t('მომსახურება', 'Services', 'Услуги')],
  ['commercial_space', t('კომერციული ფართი', 'Commercial space', 'Коммерческая площадь')],
  ['other', t('სხვა', 'Other', 'Другое')],
  ['any', t('ნებისმიერი', 'Any', 'Любой')],
]

const ask = (id: QuestionId, locale: Locale) => pick(questions.find((q) => q.id === id)!.ask, locale)
const fixed = (id: QuestionId, locale: Locale) => (questions.find((q) => q.id === id)?.options ?? []).map((o) => ({ value: String(Object.values(o.patch)[0]), label: pick(o.label, locale) }))

// The standard form, with what the profile already holds pre-selected.
export function standardForm(p: Profile, locale: Locale): IntakeForm {
  const budget = val(p, 'budgetGel')
  const cities = val(p, 'cities')
  const sectors = val(p, 'sectors')
  const sectorValue = sectors === undefined ? undefined : sectors.length === 0 ? 'any' : SECTOR_OPTIONS.find(([v]) => v.split(',').includes(sectors[0]!))?.[0]
  const cityValue = val(p, 'locationFlexible') === true ? 'any' : cities?.length ? (CITIES.find(([c]) => c === cities[0])?.[0] ?? 'other') : undefined
  const qs: IntakeForm['questions'] = [
    { field: 'budget', question: ask('budget', locale), options: BUDGET.map(([v, l]) => ({ value: String(v), label: pick(l, locale) })), selected: budget ? String(budgetBucket(budget)) : undefined },
    { field: 'goal', question: ask('goal', locale), options: fixed('goal', locale), selected: val(p, 'goal') },
    { field: 'involvement', question: ask('involvement', locale), options: fixed('involvement', locale), selected: val(p, 'involvement') },
    { field: 'location', question: ask('location', locale), options: CITIES.map(([v, l]) => ({ value: v, label: pick(l, locale) })), selected: cityValue },
    { field: 'sector', question: ask('sector', locale), options: SECTOR_OPTIONS.map(([v, l]) => ({ value: v, label: pick(l, locale) })), selected: sectorValue },
  ]
  return { title: pick(TITLE, locale), questions: qs, noteLabel: pick(NOTE, locale), submitLabel: pick(SUBMIT, locale) }
}
